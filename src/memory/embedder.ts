/**
 * Embedder — local text embedding via @huggingface/transformers.
 *
 * Uses Xenova/all-MiniLM-L6-v2 (384 dimensions, ~22MB model).
 * Runs entirely in-process — no API calls, no cost.
 */

import { createLogger } from '../utils/logger';

const log = createLogger('Embedder');

const MODEL_NAME = 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_DIM = 384;

type FeatureExtractionPipeline = (
  text: string | string[],
  options?: { pooling?: string; normalize?: boolean },
) => Promise<{ data: Float32Array }>;

export class Embedder {
  private pipeline: FeatureExtractionPipeline | null = null;
  private initPromise: Promise<void> | null = null;

  get dimensions(): number {
    return EMBEDDING_DIM;
  }

  /** Load the embedding model. Call once at startup. */
  async init(): Promise<void> {
    if (this.pipeline) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.loadModel();
    return this.initPromise;
  }

  private async loadModel(): Promise<void> {
    const start = performance.now();
    log.info(`Loading embedding model "${MODEL_NAME}"...`);

    const { pipeline } = await import('@huggingface/transformers');
    this.pipeline = (await pipeline('feature-extraction', MODEL_NAME)) as unknown as FeatureExtractionPipeline;

    log.info(`Embedding model loaded in ${(performance.now() - start).toFixed(0)}ms`);
  }

  /** Embed a single text. Returns Float32Array of length 384. */
  async embed(text: string): Promise<Float32Array> {
    await this.init();

    const result = await this.pipeline!(text, {
      pooling: 'mean',
      normalize: true,
    });

    return new Float32Array(result.data);
  }

  /** Cosine similarity between two normalized vectors. Returns value in [-1, 1]. */
  static cosineSimilarity(a: Float32Array, b: Float32Array): number {
    let dot = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
    }
    return dot;
  }

  /** Embed multiple texts in one call (more efficient than calling embed() in a loop). */
  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    await this.init();

    const results: Float32Array[] = [];
    // Process one at a time to avoid memory issues with large batches
    for (const text of texts) {
      const result = await this.pipeline!(text, {
        pooling: 'mean',
        normalize: true,
      });
      results.push(new Float32Array(result.data));
    }

    return results;
  }
}
