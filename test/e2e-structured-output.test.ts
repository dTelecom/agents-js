/**
 * End-to-end test for structured output (multi-language segment routing).
 *
 * Uses real OpenRouter API — requires OPENROUTER_API_KEY env var.
 * Skipped when the key is not set.
 */

import { describe, it, expect, vi } from 'vitest';
import { OpenRouterLLM } from '../src/providers/openrouter-llm';
import { Pipeline } from '../src/core/pipeline';
import { MockSTT, MockTTS, MockAudioOutput } from './helpers/mock-providers';
import type { LLMChunk } from '../src/core/types';

// Suppress logger output in tests
vi.mock('../src/utils/logger', () => ({
  createLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

const API_KEY = process.env.OPENROUTER_API_KEY;

const RESPONSE_FORMAT = {
  type: 'json_schema' as const,
  json_schema: {
    name: 'language_segments',
    strict: true,
    schema: {
      type: 'object',
      properties: {
        segments: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              lang: { type: 'string', enum: ['en', 'es'] },
              text: { type: 'string' },
            },
            required: ['lang', 'text'],
            additionalProperties: false,
          },
        },
      },
      required: ['segments'],
      additionalProperties: false,
    },
  },
};

const TUTOR_PROMPT = `You are Tessa, a friendly Spanish tutor for absolute beginners.
This is lesson 1: Greetings & Introductions.
Teach: hola (hello), buenos días (good morning), buenas tardes (good afternoon).

IMPORTANT — Voice routing format:
Your response MUST be a JSON object with a "segments" array. Each segment has "lang" and "text".
Each segment is spoken by a DIFFERENT VOICE — "en" = English voice, "es" = native Spanish voice.

CRITICAL: A Spanish word in an "en" segment will be MISPRONOUNCED by the English voice. Every Spanish word MUST be in its own "es" segment so it is pronounced correctly.

Rules:
- ALWAYS start with an "en" segment.
- "en" segments MUST contain ONLY English words. NEVER put Spanish words inside an "en" segment.
- Every Spanish word or phrase MUST be in an "es" segment — even if it's just one word.
- Keep "es" segments SHORT: just the word/phrase being taught.
- ALWAYS explain the meaning in English BEFORE or AFTER the "es" segment.
- Do NOT echo back what the student just said in "es" — acknowledge in English instead.
- NEVER return an empty segments array.

CORRECT — "buenas tardes" pronounced by native voice:
[{"lang":"en","text":"Now, in the afternoon, we say"},{"lang":"es","text":"buenas tardes"},{"lang":"en","text":"which means good afternoon. Can you try saying it?"}]

WRONG — "buenas tardes" mispronounced by English voice:
[{"lang":"en","text":"Now, in the afternoon, we say buenas tardes for good afternoon."}]`;

// Spanish words/phrases that must be in <lang> tags, not plain English
const SPANISH_WORDS = [
  'hola',
  'buenos días',
  'buenos dias',
  'buenas tardes',
  'buenas noches',
];

/**
 * Check TTS calls for language separation violations.
 * Text outside <lang> tags is spoken by the English voice — it must not
 * contain Spanish vocabulary (which would be mispronounced).
 */
function checkTTSCalls(
  calls: string[],
  turnLabel: string,
): string[] {
  const violations: string[] = [];

  for (const call of calls) {
    // Strip <lang> tagged content to get only the English-voice portions
    const englishOnly = call.replace(/<lang[^>]*>.*?<\/lang>/g, ' ');
    const lower = englishOnly.toLowerCase();

    for (const word of SPANISH_WORDS) {
      if (lower.includes(word)) {
        violations.push(
          `[${turnLabel}] Spanish "${word}" sent to English voice: "${englishOnly.trim()}"`,
        );
      }
    }
  }

  return violations;
}

describe.skipIf(!API_KEY)('Structured Output E2E', () => {
  // ── Basic LLM tests ────────────────────────────────────────────────────

  it('yields segment chunks (not token chunks) in structured mode', async () => {
    const llm = new OpenRouterLLM({
      apiKey: API_KEY!,
      model: 'openai/gpt-4.1-mini',
      maxTokens: 200,
      responseFormat: RESPONSE_FORMAT,
    });

    const chunks: LLMChunk[] = [];
    for await (const chunk of llm.chat([
      { role: 'system', content: TUTOR_PROMPT },
      { role: 'user', content: 'Hello' },
    ])) {
      chunks.push(chunk);
    }

    const segments = chunks.filter((c) => c.type === 'segment');
    const tokens = chunks.filter((c) => c.type === 'token');

    // Structured mode: no raw JSON tokens, only segments
    expect(tokens).toHaveLength(0);
    expect(segments.length).toBeGreaterThan(0);

    // Every segment has valid lang and non-empty text
    for (const seg of segments) {
      expect(seg.segment).toBeDefined();
      expect(seg.segment!.lang).toMatch(/^(en|es)$/);
      expect(seg.segment!.text.length).toBeGreaterThan(0);
    }

    // No JSON leaked
    const fullText = segments.map((s) => s.segment!.text).join(' ');
    expect(fullText).not.toContain('"segments"');
    expect(fullText).not.toContain('{');

    // First segment must be English
    expect(segments[0].segment!.lang).toBe('en');

    console.log('\n=== LLM Segments (Hello) ===');
    for (const seg of segments) {
      console.log(`  [${seg.segment!.lang}] ${seg.segment!.text}`);
    }
    console.log('============================\n');
  }, 30_000);

  it('yields regular token chunks without responseFormat', async () => {
    const llm = new OpenRouterLLM({
      apiKey: API_KEY!,
      model: 'openai/gpt-4.1-mini',
      maxTokens: 50,
    });

    const chunks: LLMChunk[] = [];
    for await (const chunk of llm.chat([
      { role: 'user', content: 'Say "hello" in one word.' },
    ])) {
      chunks.push(chunk);
    }

    expect(chunks.filter((c) => c.type === 'token').length).toBeGreaterThan(0);
    expect(chunks.filter((c) => c.type === 'segment')).toHaveLength(0);
  }, 30_000);

  // ── Full lesson through Pipeline (real flow) ──────────────────────────

  it('Full Spanish lesson: 6 turns through Pipeline with language separation', async () => {
    const llm = new OpenRouterLLM({
      apiKey: API_KEY!,
      model: 'openai/gpt-4.1-mini',
      maxTokens: 300,
      responseFormat: RESPONSE_FORMAT,
    });

    const stt = new MockSTT();
    const tts = new MockTTS();
    (tts as any).defaultLanguage = 'en';
    const audioOutput = new MockAudioOutput();

    const pipeline = new Pipeline({
      stt,
      llm,
      tts,
      audioOutput: audioOutput as any,
      instructions: TUTOR_PROMPT,
    });

    const allViolations: string[] = [];

    /** Wait for pipeline to finish processing. */
    async function waitForIdle() {
      for (let i = 0; i < 600; i++) {
        if (!pipeline.processing) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('Pipeline stuck in processing state');
    }

    /** Simulate a student turn and return the response + TTS calls. */
    async function studentSays(text: string, turnLabel: string) {
      // Wait for previous turn to fully complete
      await waitForIdle();

      tts.synthesizeCalls.length = 0;
      pipeline.removeAllListeners('response');

      const responsePromise = new Promise<string>((resolve) => {
        pipeline.on('response', resolve);
      });
      // Timeout: if the LLM returns empty segments, 'response' is never emitted
      const timeoutPromise = new Promise<string>((resolve) =>
        setTimeout(() => resolve(''), 30_000),
      );

      // If no STT stream yet, add participant
      if (stt.streams.length === 0) {
        pipeline.addParticipant('student');
      }

      // Use latest stream
      const stream = stt.streams[stt.streams.length - 1];
      stream.simulateTranscription(text, true);

      const response = await Promise.race([responsePromise, timeoutPromise]);

      // Check TTS calls for language separation
      const violations = checkTTSCalls(tts.synthesizeCalls, turnLabel);
      allViolations.push(...violations);

      // Response must not be empty
      if (!response.trim()) {
        allViolations.push(`[${turnLabel}] Empty response`);
      }

      // Response must not contain JSON
      if (response.includes('"segments"') || /^\s*\{/.test(response)) {
        allViolations.push(`[${turnLabel}] JSON leaked to response: "${response.slice(0, 80)}"`);
      }

      // Response must not contain SSML tags (clean text)
      if (response.includes('<lang')) {
        allViolations.push(`[${turnLabel}] SSML tags in response: "${response.slice(0, 80)}"`);
      }

      console.log(`\n=== ${turnLabel} ===`);
      console.log(`Student: "${text}"`);
      console.log('TTS calls:');
      for (const call of tts.synthesizeCalls) {
        console.log(`  ${call.includes('<lang') ? '[tagged]' : '[plain] '} ${call}`);
      }
      console.log(`Response: ${response}`);

      return { response, ttsCalls: [...tts.synthesizeCalls] };
    }

    // ── Step 0: Greeting via say() ──
    tts.synthesizeCalls.length = 0;
    const greetingPromise = new Promise<string>((resolve) => {
      pipeline.on('response', resolve);
    });
    await pipeline.say('Hi! Welcome to your first Spanish lesson.');
    await greetingPromise;

    expect(tts.synthesizeCalls).toHaveLength(1);
    expect(tts.synthesizeCalls[0]).toBe('Hi! Welcome to your first Spanish lesson.');

    console.log('\n=== Step 0: Greeting ===');
    console.log(`TTS: ${tts.synthesizeCalls[0]}`);

    // ── Turn 1: Student says "Hello" ──
    const turn1 = await studentSays('Hello', 'Turn 1 (Hello)');

    // Must have at least one <lang> tag for Spanish
    expect(turn1.ttsCalls.some((c) => c.includes('<lang xml:lang="es">'))).toBe(true);

    // ── Turn 2: Student says "Hola" (repeating the word) ──
    const turn2 = await studentSays('Hola', 'Turn 2 (Hola)');

    // Response must not be empty
    expect(turn2.response.length).toBeGreaterThan(5);

    // ── Turn 3: Student says "Buenos días" ──
    const turn3 = await studentSays('Buenos días', 'Turn 3 (Buenos días)');
    if (!turn3.response) {
      console.warn('  ⚠ Turn 3: LLM returned empty response (known issue)');
    }

    // ── Turn 4: Student asks "How do I say good afternoon?" ──
    const turn4 = await studentSays('How do I say good afternoon?', 'Turn 4 (good afternoon?)');

    // Must teach "buenas tardes" via Spanish TTS (if non-empty)
    if (turn4.response) {
      expect(turn4.ttsCalls.some((c) => c.includes('<lang xml:lang="es">'))).toBe(true);
    }

    // ── Turn 5: Student says "Buenas tardes" ──
    const turn5 = await studentSays('Buenas tardes', 'Turn 5 (Buenas tardes)');

    // ── Turn 6: Student asks for review ──
    const turn6 = await studentSays('Can you review everything we learned?', 'Turn 6 (review)');

    // Review should use Spanish TTS for at least 3 words (if non-empty)
    if (turn6.response) {
      const reviewEsTags = turn6.ttsCalls.join('').match(/<lang xml:lang="es">/g) || [];
      expect(reviewEsTags.length).toBeGreaterThanOrEqual(3);
    }

    // ── Final verdict ──
    console.log('\n=== Violations ===');
    if (allViolations.length === 0) {
      console.log('  ✓ No violations found');
    } else {
      for (const v of allViolations) {
        console.log(`  ✗ ${v}`);
      }
    }
    console.log('==================\n');

    // Language mixing violations are hard failures
    const mixingViolations = allViolations.filter((v) => v.includes('sent to English voice'));
    expect(mixingViolations).toHaveLength(0);

    await pipeline.stop();
  }, 120_000);

  // ── say() test ────────────────────────────────────────────────────────

  it('say() sends plain text without lang tags', async () => {
    const llm = new OpenRouterLLM({
      apiKey: API_KEY!,
      model: 'openai/gpt-4.1-mini',
      maxTokens: 50,
      responseFormat: RESPONSE_FORMAT,
    });

    const stt = new MockSTT();
    const tts = new MockTTS();
    (tts as any).defaultLanguage = 'en';
    const audioOutput = new MockAudioOutput();

    const pipeline = new Pipeline({
      stt,
      llm,
      tts,
      audioOutput: audioOutput as any,
      instructions: TUTOR_PROMPT,
    });

    const responsePromise = new Promise<string>((resolve) => {
      pipeline.on('response', resolve);
    });

    await pipeline.say('Hi! Welcome to your Spanish lesson.');
    const response = await responsePromise;

    expect(tts.synthesizeCalls).toHaveLength(1);
    expect(tts.synthesizeCalls[0]).toBe('Hi! Welcome to your Spanish lesson.');
    expect(response).toBe('Hi! Welcome to your Spanish lesson.');

    await pipeline.stop();
  }, 30_000);
});
