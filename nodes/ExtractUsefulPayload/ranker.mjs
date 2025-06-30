import { pipeline } from '@xenova/transformers';
import { encode } from 'gpt-3-encoder';
import fs from 'fs/promises';

function cosineSimilarity(a, b) {
  const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return dot / (magA * magB);
}

function smartChunk(text, maxChunkLength = 300) {
    const chunks = [];
    const cleaned = text.replace(/\s+/g, ' ').trim();
  
    let i = 0;
    while (i < cleaned.length) {
      const chunk = cleaned.slice(i, i + maxChunkLength).trim();
  
      if (chunk.length >= 30 && /[a-zA-Zа-яА-Я]{4,}/.test(chunk)) {
        chunks.push(chunk);
      }
  
      i += maxChunkLength - 50; // перекрытие
    }
  
    return chunks;
  }

async function rank(text, maxTokens) {
  const cleaned = text.replace(/\s+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  const chunks = smartChunk(cleaned, 300);

  if (chunks.length === 0) {
    console.log(JSON.stringify({ text: '', tokenCount: 0, sentenceCount: 0 }));
    return;
  }

  const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');

  const embeddings = await Promise.all(chunks.map(async (chunk) => {
    const emb = await extractor(chunk, { pooling: 'mean', normalize: true });
    return { sentence: chunk, vector: emb.data };
  }));

  const mean = embeddings[0].vector.map((_, i) =>
    embeddings.reduce((sum, e) => sum + e.vector[i], 0) / embeddings.length
  );

  embeddings.forEach(e => {
    e.score = cosineSimilarity(e.vector, mean);
  });

  const sorted = embeddings.sort((a, b) => b.score - a.score);
  const result = [];
  let tokenCount = 0;

  for (const { sentence } of sorted) {
    const tokens = encode(sentence);
    if (tokenCount + tokens.length > maxTokens) break;
    result.push(sentence);
    tokenCount += tokens.length;
  }

  console.log(JSON.stringify({
    text: result.join(' '),
    tokenCount,
    sentenceCount: result.length
  }));
}

const [filePath, maxTokensStr] = process.argv.slice(2);
const inputText = await fs.readFile(filePath, 'utf8');
await rank(inputText, parseInt(maxTokensStr, 10));
