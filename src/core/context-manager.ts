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
  /** Max tokens before triggering summarization (default: 5000) */
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
   * [recent verbatim turns]
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

    // Format turns as messages
    const turnsToInclude = this.summary
      ? this.turns.slice(-this.recentTurnsToKeep)
      : this.turns;

    for (const turn of turnsToInclude) {
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

  /** Check if summarization should be triggered */
  shouldSummarize(): boolean {
    const totalTokens = this.turns.reduce(
      (acc, t) => acc + estimateTokens(t.text) + 10,
      estimateTokens(this.instructions),
    );
    return totalTokens > this.maxContextTokens;
  }

  /**
   * Summarize older turns using the LLM.
   * Keeps the most recent turns verbatim.
   */
  async summarize(llm: LLMPlugin, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    if (this.turns.length <= this.recentTurnsToKeep) return;

    const olderTurns = this.turns.slice(0, -this.recentTurnsToKeep);
    const transcript = olderTurns
      .map((t) => `[${t.speaker}]: ${t.text}`)
      .join('\n');

    const summaryPrompt: Message[] = [
      {
        role: 'system',
        content: 'Summarize this conversation concisely, preserving key facts, decisions, and action items.',
      },
      { role: 'user', content: transcript },
    ];

    let summaryText = '';
    for await (const chunk of llm.chat(summaryPrompt, signal)) {
      signal?.throwIfAborted();
      if (chunk.type === 'token' && chunk.token) {
        summaryText += chunk.token;
      }
    }

    // Some providers finish quietly on cancellation. Never commit their partial summary.
    signal?.throwIfAborted();
    this.summary = this.summary
      ? `${this.summary}\n\n${summaryText}`
      : summaryText;

    this.turns = this.turns.slice(-this.recentTurnsToKeep);

    log.info(`Summarized ${olderTurns.length} turns, ${this.turns.length} recent turns kept`);
  }

  /** Get the full transcript */
  getFullTranscript(): string {
    return this.turns.map((t) => `[${t.speaker}]: ${t.text}`).join('\n');
  }

  /** Reset the context */
  reset(): void {
    this.turns = [];
    this.summary = null;
  }
}

/** The messages of a tool round: the assistant's calls, then one result per call. */
export function toolMessages(exchange: ToolExchange): Message[] {
  return [
    { role: 'assistant', content: exchange.content, tool_calls: exchange.calls },
    ...exchange.results.map((r): Message => ({ role: 'tool', tool_call_id: r.id, content: r.content })),
  ];
}
