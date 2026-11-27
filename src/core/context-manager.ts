import type { Message, LLMPlugin, ToolCallPart } from './types';
import { createLogger } from '../utils/logger';

const log = createLogger('ContextManager');

/** Rough token estimate: 1 token ~ 4 chars */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface ContextManagerOptions {
  /** System instructions for the agent */
  instructions: string;
  /**
   * Conversation size, in estimated tokens, above which older turns are summarized (default: 5000).
   * Counts the turns and the current summary; the instructions are not counted.
   */
  maxContextTokens?: number;
  /** Number of recent turns to keep verbatim (default: 4) */
  recentTurnsToKeep?: number;
}

/** One tool round: what the agent said with the calls, the calls and their results. */
export interface ToolExchange {
  content: string | null;
  calls: ToolCallPart[];
  results: Array<{ id: string; content: string }>;
}

interface Turn {
  speaker: string;
  /** Plain text for summaries and size estimates. */
  text: string;
  isAgent: boolean;
  timestamp: number;
  /** Set on an agent turn that called tools: sent back as an assistant tool call and its results. */
  tool?: ToolExchange;
}

export class ContextManager {
  private readonly instructions: string;
  private readonly maxContextTokens: number;
  private readonly recentTurnsToKeep: number;

  private turns: Turn[] = [];
  private summary: string | null = null;
  /** Bumped by reset(): a summary started before it is discarded. */
  private generation = 0;
  private summarizing = false;

  constructor(options: ContextManagerOptions) {
    this.instructions = options.instructions;
    this.maxContextTokens = options.maxContextTokens ?? 5000;
    this.recentTurnsToKeep = options.recentTurnsToKeep ?? 4;
  }

  /** Add a user's speech turn to the conversation */
  addUserTurn(speaker: string, text: string): void {
    this.turns.push({
      speaker,
      text,
      isAgent: false,
      timestamp: Date.now(),
    });
  }

  /**
   * Add a tool round. It stays one turn, so the call and its results are kept or summarized
   * together and the model always sees a result for every call.
   */
  addToolExchange(exchange: ToolExchange): void {
    const calls = exchange.calls
      .map((call, i) => `${call.function.name}(${call.function.arguments}) → ${exchange.results[i]?.content ?? ''}`)
      .join('; ');
    this.turns.push({
      speaker: 'assistant',
      text: `${exchange.content ? `${exchange.content} ` : ''}[tool ${calls}]`,
      isAgent: true,
      timestamp: Date.now(),
      tool: exchange,
    });
  }

  /** Add the agent's response to the conversation */
  addAgentTurn(text: string): void {
    this.turns.push({
      speaker: 'assistant',
      text,
      isAgent: true,
      timestamp: Date.now(),
    });
  }

  /**
   * Build the messages array for the LLM call.
   *
   * Structure:
   * [system prompt]
   * [memory context, if provided]
   * [conversation summary, if any]
   * [turns not yet summarized, verbatim]
   *
   * @param memoryContext - Optional relevant context injected by the application
   */
  buildMessages(memoryContext?: string): Message[] {
    const messages: Message[] = [];

    // System prompt
    messages.push({ role: 'system', content: this.instructions });

    // Application-injected memory context (if available)
    if (memoryContext) {
      messages.push({
        role: 'system',
        content: `Relevant context from past conversations:\n${memoryContext}`,
      });
    }

    // Conversation summary (if summarization has occurred)
    if (this.summary) {
      messages.push({
        role: 'system',
        content: `Conversation summary so far:\n${this.summary}`,
      });
    }

    // The summary covers only the turns it replaced: every remaining turn is sent verbatim.
    for (const turn of this.turns) {
      if (turn.tool) {
        messages.push(...toolMessages(turn.tool));
      } else if (turn.isAgent) {
        messages.push({ role: 'assistant', content: turn.text });
      } else {
        messages.push({
          role: 'user',
          content: `[${turn.speaker}]: ${turn.text}`,
        });
      }
    }

    return messages;
  }

  /**
   * Whether the conversation (turns plus the current summary) is over `maxContextTokens`.
   * The instructions are sent with every request either way, so they are not counted.
   */
  shouldSummarize(): boolean {
    const totalTokens = this.turns.reduce(
      (acc, t) => acc + estimateTokens(t.text) + 10,
      this.summary ? estimateTokens(this.summary) : 0,
    );
    return totalTokens > this.maxContextTokens;
  }

  /**
   * Summarize older turns using the LLM, keeping the most recent turns verbatim. The new summary
   * covers the previous one and replaces it.
   *
   * Turns added while the summary is generated are kept: only the turns it covers are removed.
   * One summary runs at a time (a concurrent call returns false); a reset() during the call
   * discards its result. Resolves true when a summary was committed. Rejects on cancellation,
   * on a provider error and on an empty summary, leaving the context unchanged.
   */
  async summarize(llm: LLMPlugin, signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted();
    const count = this.turns.length - this.recentTurnsToKeep;
    if (count <= 0 || this.summarizing) return false;

    this.summarizing = true;
    try {
      const generation = this.generation;
      const transcript = this.turns
        .slice(0, count)
        .map((t) => `[${t.speaker}]: ${t.text}`)
        .join('\n');
      const previous = this.summary;

      const summaryPrompt: Message[] = [
        {
          role: 'system',
          content: 'Summarize this conversation concisely, preserving key facts, decisions, and action items. ' +
            'When a summary so far is given, write one summary that covers it and the new turns.',
        },
        {
          role: 'user',
          content: previous ? `Summary so far:\n${previous}\n\nNew turns:\n${transcript}` : transcript,
        },
      ];

      let summaryText = '';
      for await (const chunk of llm.chat(summaryPrompt, signal, { plainText: true })) {
        signal?.throwIfAborted();
        if (chunk.type === 'token' && chunk.token) {
          summaryText += chunk.token;
        }
      }

      // Some providers finish quietly on cancellation. Never commit their partial summary.
      signal?.throwIfAborted();
      if (generation !== this.generation) {
        log.info('Discarded a summary started before the context was reset');
        return false;
      }
      // An empty summary would drop the previous one together with the turns.
      if (!summaryText.trim()) throw new Error('Summary was empty');

      this.summary = summaryText.trim();
      this.turns = this.turns.slice(count);
      log.info(`Summarized ${count} turns, ${this.turns.length} turns kept`);
      return true;
    } finally {
      this.summarizing = false;
    }
  }

  /** Get the full transcript */
  getFullTranscript(): string {
    return this.turns.map((t) => `[${t.speaker}]: ${t.text}`).join('\n');
  }

  /** Reset the context */
  reset(): void {
    this.turns = [];
    this.summary = null;
    this.generation++;
  }
}

/** The messages of a tool round: the assistant's calls, then one result per call. */
export function toolMessages(exchange: ToolExchange): Message[] {
  return [
    { role: 'assistant', content: exchange.content, tool_calls: exchange.calls },
    ...exchange.results.map((r): Message => ({ role: 'tool', tool_call_id: r.id, content: r.content })),
  ];
}
