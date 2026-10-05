import type { Embedder } from "../src/semantic/embedder.ts";

// A stand-in for EmbeddingGemma: words map to a handful of concepts, and a
// text's vector counts the concepts it mentions. Words outside the table are
// ignored, so "crinkly wrapper" means the same as "packaging", and texts that
// share no concept have similarity 0.
const CONCEPTS: Record<string, string[]> = {
  packaging: ["packaging", "bag", "wrapper", "pouch", "label"],
  snack: ["chips", "snack", "snacks", "tortilla", "crisps"],
  coffee: ["coffee", "brewing", "espresso", "barista", "pour"],
  code: ["swift", "code", "programming", "snippet", "photokit"],
  sport: ["pickleball", "sports", "training", "court", "paddle"],
  purchase: ["receipt", "order", "purchase", "proof", "bought", "paid"],
};
const NAMES = Object.keys(CONCEPTS);
const CONCEPT_OF = new Map(Object.entries(CONCEPTS).flatMap(([concept, words]) => words.map((w) => [w, concept])));

export function fakeVector(text: string): Float32Array {
  const v = new Float32Array(NAMES.length);
  for (const word of text.toLowerCase().match(/[a-z]+/g) ?? []) {
    const concept = CONCEPT_OF.get(word);
    if (concept) v[NAMES.indexOf(concept)]! += 1;
  }
  const norm = Math.hypot(...v);
  return norm ? v.map((x) => x / norm) : v;
}

export class FakeEmbedder implements Embedder {
  readonly model = "fake-concepts";
  documentsEmbedded = 0;
  closed = false;

  async embedQueries(queries: string[]): Promise<Float32Array[]> {
    return queries.map(fakeVector);
  }

  async embedDocuments(docs: Array<{ title: string | null; text: string }>): Promise<Float32Array[]> {
    this.documentsEmbedded += docs.length;
    return docs.map((d) => fakeVector(`${d.title ?? ""} ${d.text}`));
  }

  close(): void {
    this.closed = true;
  }
}
