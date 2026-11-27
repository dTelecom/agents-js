import { describe, it, expect } from 'vitest';
import { ContextManager } from '../src/core/context-manager';
import type { LLMPlugin, Message } from '../src/core/types';
import { MockLLM } from './helpers/mock-providers';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(r => { resolve = r; });
  return { promise, resolve };
}

/** An LLM whose summary waits for `gate` before it streams `text`. */
function gatedSummaryLLM(text: string) {
  const gate = deferred();
  const calls: Message[][] = [];
  const options: unknown[] = [];
  const llm: LLMPlugin = {
    async *chat(messages, _signal, chatOptions) {
      calls.push(messages);
      options.push(chatOptions);
      await gate.promise;
      yield { type: 'token', token: text };
      yield { type: 'done' };
    },
  };
  return { llm, calls, options, release: gate.resolve };
}

function addTurns(cm: ContextManager, n: number, prefix = 'Turn') {
  for (let i = 0; i < n; i++) {
    if (i % 2 === 0) cm.addUserTurn('Alice', `${prefix} ${i}`);
    else cm.addAgentTurn(`${prefix} ${i}`);
  }
}

describe('ContextManager', () => {
  const instructions = 'You are a helpful tutor.';

  it('buildMessages with system prompt only', () => {
    const cm = new ContextManager({ instructions });
    const messages = cm.buildMessages();
    expect(messages).toEqual([{ role: 'system', content: instructions }]);
  });

  it('addUserTurn formats as [speaker]: text', () => {
    const cm = new ContextManager({ instructions });
    cm.addUserTurn('Alice', 'Hello there');
    const messages = cm.buildMessages();
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({ role: 'user', content: '[Alice]: Hello there' });
  });

  it('addAgentTurn has role assistant', () => {
    const cm = new ContextManager({ instructions });
    cm.addAgentTurn('Hi Alice!');
    const messages = cm.buildMessages();
    expect(messages).toHaveLength(2);
    expect(messages[1]).toEqual({ role: 'assistant', content: 'Hi Alice!' });
  });

  it('buildMessages with memoryContext inserts system message after instructions', () => {
    const cm = new ContextManager({ instructions });
    cm.addUserTurn('Bob', 'What was my score?');
    const messages = cm.buildMessages('Bob scored 95 on the last quiz.');
    expect(messages).toHaveLength(3);
    expect(messages[0]).toEqual({ role: 'system', content: instructions });
    expect(messages[1]).toEqual({
      role: 'system',
      content: 'Relevant context from past conversations:\nBob scored 95 on the last quiz.',
    });
    expect(messages[2]).toEqual({ role: 'user', content: '[Bob]: What was my score?' });
  });

  it('shouldSummarize returns true when token budget exceeded', () => {
    const cm = new ContextManager({ instructions, maxContextTokens: 50 });
    // Each turn adds ~10 overhead + text tokens
    // With maxContextTokens=50, a few long turns should exceed it
    cm.addUserTurn('User', 'A'.repeat(100));
    cm.addAgentTurn('B'.repeat(100));
    expect(cm.shouldSummarize()).toBe(true);
  });

  it('shouldSummarize returns false when within budget', () => {
    const cm = new ContextManager({ instructions, maxContextTokens: 5000 });
    cm.addUserTurn('User', 'Hello');
    expect(cm.shouldSummarize()).toBe(false);
  });

  it('summarize replaces old turns with summary', async () => {
    const cm = new ContextManager({
      instructions,
      maxContextTokens: 50,
      recentTurnsToKeep: 2,
    });

    // Add 6 turns — first 4 should be summarized, last 2 kept
    cm.addUserTurn('Alice', 'First question');
    cm.addAgentTurn('First answer');
    cm.addUserTurn('Alice', 'Second question');
    cm.addAgentTurn('Second answer');
    cm.addUserTurn('Alice', 'Third question');
    cm.addAgentTurn('Third answer');

    const llm = new MockLLM('Summary of the conversation so far.');
    await cm.summarize(llm);

    // LLM should have been called with a summary prompt
    expect(llm.calls).toHaveLength(1);

    const messages = cm.buildMessages();
    // Should have: system prompt, summary, 2 recent turns
    expect(messages[0].role).toBe('system');
    expect(messages[0].content).toBe(instructions);
    // Summary message
    const summaryMsg = messages.find((m) => m.content.includes('Conversation summary'));
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg!.content).toContain('Summary of the conversation so far.');
  });

  it('does not count the instructions: long instructions with a short history need no summary', () => {
    // ~10,000 estimated tokens of instructions, twice the budget.
    const cm = new ContextManager({ instructions: 'x'.repeat(40_000), maxContextTokens: 5000 });
    addTurns(cm, 6);
    expect(cm.shouldSummarize()).toBe(false);
  });

  it('counts the current summary with the turns', async () => {
    const cm = new ContextManager({ instructions, maxContextTokens: 100, recentTurnsToKeep: 1 });
    addTurns(cm, 3);
    await cm.summarize(new MockLLM('S'.repeat(400)));
    // One short turn is left; the 100-token summary alone passes the budget.
    expect(cm.shouldSummarize()).toBe(true);
  });

  it('replaces the previous summary with one that covers it', async () => {
    const cm = new ContextManager({ instructions, recentTurnsToKeep: 2 });
    addTurns(cm, 4, 'First');
    const first = new MockLLM('First summary.');
    expect(await cm.summarize(first)).toBe(true);
    expect(first.calls[0][1].content).toBe('[Alice]: First 0\n[assistant]: First 1');

    addTurns(cm, 2, 'Second');
    const second = new MockLLM('Combined summary.');
    await cm.summarize(second);
    expect(second.calls[0][1].content).toBe(
      'Summary so far:\nFirst summary.\n\nNew turns:\n[Alice]: First 2\n[assistant]: First 3',
    );
    const summaries = cm.buildMessages().filter(m => m.content?.includes('Conversation summary'));
    expect(summaries).toEqual([{ role: 'system', content: 'Conversation summary so far:\nCombined summary.' }]);
    expect(cm.buildMessages().slice(2).map(m => m.content)).toEqual(['[Alice]: Second 0', 'Second 1']);
  });

  it('asks for plain text, so structured-output providers can summarize', async () => {
    const cm = new ContextManager({ instructions, recentTurnsToKeep: 1 });
    addTurns(cm, 3);
    const { llm, options, release } = gatedSummaryLLM('Summary.');
    release();
    await cm.summarize(llm);
    expect(options).toEqual([{ plainText: true }]);
  });

  it('keeps turns added while the summary is generated: only the summarized ones are removed', async () => {
    const cm = new ContextManager({ instructions, recentTurnsToKeep: 2 });
    addTurns(cm, 4, 'Old');
    const { llm, release } = gatedSummaryLLM('Old summary.');
    const done = cm.summarize(llm);
    cm.addUserTurn('Alice', 'Asked meanwhile');
    cm.addAgentTurn('Answered meanwhile');
    release();
    expect(await done).toBe(true);
    expect(cm.buildMessages()).toEqual([
      { role: 'system', content: instructions },
      { role: 'system', content: 'Conversation summary so far:\nOld summary.' },
      { role: 'user', content: '[Alice]: Old 2' },
      { role: 'assistant', content: 'Old 3' },
      { role: 'user', content: '[Alice]: Asked meanwhile' },
      { role: 'assistant', content: 'Answered meanwhile' },
    ]);
  });

  it('runs one summary at a time', async () => {
    const cm = new ContextManager({ instructions, recentTurnsToKeep: 1 });
    addTurns(cm, 4);
    const { llm, calls, release } = gatedSummaryLLM('Summary.');
    const first = cm.summarize(llm);
    expect(await cm.summarize(llm)).toBe(false);
    release();
    expect(await first).toBe(true);
    expect(calls).toHaveLength(1);
    expect(cm.getFullTranscript()).toBe('[assistant]: Turn 3');
  });

  it('discards a summary that finishes after reset()', async () => {
    const cm = new ContextManager({ instructions, recentTurnsToKeep: 1 });
    addTurns(cm, 4);
    const { llm, release } = gatedSummaryLLM('Stale summary.');
    const done = cm.summarize(llm);
    cm.reset();
    cm.addUserTurn('Alice', 'After reset');
    release();
    expect(await done).toBe(false);
    expect(cm.buildMessages()).toEqual([
      { role: 'system', content: instructions },
      { role: 'user', content: '[Alice]: After reset' },
    ]);
  });

  it('rejects an empty summary and keeps the turns and the previous summary', async () => {
    const cm = new ContextManager({ instructions, recentTurnsToKeep: 1 });
    addTurns(cm, 3);
    await cm.summarize(new MockLLM('Kept summary.'));
    addTurns(cm, 2, 'More');
    const before = cm.buildMessages();
    await expect(cm.summarize(new MockLLM(''))).rejects.toThrow('Summary was empty');
    expect(cm.buildMessages()).toEqual(before);
  });

  it('getFullTranscript returns formatted transcript', () => {
    const cm = new ContextManager({ instructions });
    cm.addUserTurn('Alice', 'Hello');
    cm.addAgentTurn('Hi!');
    cm.addUserTurn('Alice', 'How are you?');

    const transcript = cm.getFullTranscript();
    expect(transcript).toBe('[Alice]: Hello\n[assistant]: Hi!\n[Alice]: How are you?');
  });

  it('reset clears all turns and summary', async () => {
    const cm = new ContextManager({
      instructions,
      maxContextTokens: 50,
      recentTurnsToKeep: 1,
    });

    cm.addUserTurn('Alice', 'A'.repeat(200));
    cm.addAgentTurn('B'.repeat(200));
    cm.addUserTurn('Alice', 'Latest');
    await cm.summarize(new MockLLM('Summary'));

    cm.reset();

    const messages = cm.buildMessages();
    expect(messages).toEqual([{ role: 'system', content: instructions }]);
    expect(cm.getFullTranscript()).toBe('');
  });

  it('multiple user and agent turns build correct message order', () => {
    const cm = new ContextManager({ instructions });
    cm.addUserTurn('Alice', 'Q1');
    cm.addAgentTurn('A1');
    cm.addUserTurn('Bob', 'Q2');
    cm.addAgentTurn('A2');

    const messages = cm.buildMessages();
    expect(messages).toEqual([
      { role: 'system', content: instructions },
      { role: 'user', content: '[Alice]: Q1' },
      { role: 'assistant', content: 'A1' },
      { role: 'user', content: '[Bob]: Q2' },
      { role: 'assistant', content: 'A2' },
    ]);
  });

  it('does not commit a partial summary when the provider finishes quietly after cancellation', async () => {
    const cm = new ContextManager({ instructions, recentTurnsToKeep: 1 });
    cm.addUserTurn('Alice', 'Earlier question');
    cm.addAgentTurn('Earlier answer');
    cm.addUserTurn('Alice', 'Current question');
    const before = cm.buildMessages();
    const controller = new AbortController();
    await expect(cm.summarize({ async *chat(_messages, signal) {
      expect(signal).toBe(controller.signal);
      yield { type: 'token', token: 'Incomplete summary' };
      controller.abort();
    } }, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(cm.buildMessages()).toEqual(before);
  });
});
