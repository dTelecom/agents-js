import { describe, it, expect } from 'vitest';
import { ContextManager } from '../src/core/context-manager';
import { MockLLM } from './helpers/mock-providers';

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
});
