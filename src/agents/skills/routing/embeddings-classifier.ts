/**
 * Embeddings Classifier
 *
 * Uses vector similarity between message content and skill domain/description
 * embeddings to classify which skills are relevant.
 *
 * This provides higher accuracy than keyword matching at the cost of latency.
 *
 * @module agents/skills/routing/embeddings-classifier
 */

import type { SkillEntry } from "../types.js";
import type {
  RoutingContext,
  RoutingSkillMetadata,
  SkillClassification,
  SkillRoutingConfig,
} from "./types.js";

/**
 * Interface for embedding providers.
 * Compatible with OpenCore's EmbeddingProvider from src/memory/embeddings.ts
 */
export interface EmbeddingProvider {
  id: string;
  model: string;
  embedQuery: (text: string) => Promise<number[]>;
  embedBatch: (texts: string[]) => Promise<number[][]>;
}

/**
 * Embeddings classifier configuration.
 */
export interface EmbeddingsClassifierConfig {
  /** Embedding model to use */
  model?: string;
  /** Cache skill embeddings across calls */
  cacheEmbeddings?: boolean;
}

/**
 * Cache for skill embeddings to avoid recomputing.
 * Key: skill name, Value: embedding vector
 */
const skillEmbeddingCache = new Map<string, number[]>();

/**
 * Clear the skill embedding cache.
 */
export function clearEmbeddingCache(): void {
  skillEmbeddingCache.clear();
}

/**
 * Calculate cosine similarity between two vectors.
 *
 * @param a - First vector
 * @param b - Second vector
 * @returns Similarity score between 0 and 1
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }
  if (a.length === 0) {
    return 0;
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const magnitudeA = Math.sqrt(normA);
  const magnitudeB = Math.sqrt(normB);

  if (magnitudeA < 1e-10 || magnitudeB < 1e-10) {
    return 0;
  }

  // Cosine similarity can be -1 to 1; normalize to 0-1 for confidence
  const similarity = dotProduct / (magnitudeA * magnitudeB);
  return (similarity + 1) / 2;
}

/**
 * Extract routing metadata from a skill entry.
 */
function getRoutingMetadata(entry: SkillEntry): RoutingSkillMetadata {
  const metadata = entry.metadata as Record<string, unknown> | undefined;
  if (!metadata) {
    return {};
  }
  return {
    domains: Array.isArray(metadata.domains) ? (metadata.domains as string[]) : undefined,
    domainWeight: typeof metadata.domainWeight === "number" ? metadata.domainWeight : undefined,
    alwaysInclude: typeof metadata.alwaysInclude === "boolean" ? metadata.alwaysInclude : undefined,
  };
}

/**
 * Build a text representation of a skill for embedding.
 *
 * @param skill - Skill entry
 * @returns Text combining domains and description
 */
function buildSkillText(skill: SkillEntry): string {
  const routing = getRoutingMetadata(skill);
  const parts: string[] = [];

  // Add domains
  if (routing.domains && routing.domains.length > 0) {
    parts.push(`Domains: ${routing.domains.join(", ")}`);
  }

  // Add skill name (cleaned)
  parts.push(`Skill: ${skill.skill.name.replace(/-/g, " ")}`);

  // Add description
  if (skill.skill.description) {
    parts.push(skill.skill.description);
  }

  return parts.join(". ");
}

/**
 * Get or compute embedding for a skill.
 *
 * @param skill - Skill entry
 * @param provider - Embedding provider
 * @param useCache - Whether to use caching
 * @returns Embedding vector
 */
async function getSkillEmbedding(
  skill: SkillEntry,
  provider: EmbeddingProvider,
  useCache: boolean,
): Promise<number[]> {
  const cacheKey = `${provider.id}:${skill.skill.name}`;

  if (useCache) {
    const cached = skillEmbeddingCache.get(cacheKey);
    if (cached) {
      return cached;
    }
  }

  const text = buildSkillText(skill);
  const embedding = await provider.embedQuery(text);

  if (useCache) {
    skillEmbeddingCache.set(cacheKey, embedding);
  }

  return embedding;
}

/**
 * Classify skills using embedding similarity.
 *
 * @param context - Routing context with user message
 * @param skills - Array of eligible skill entries
 * @param config - Routing configuration
 * @param embeddingProvider - Provider for generating embeddings
 * @returns Array of skill classifications sorted by confidence (descending)
 */
export async function classifyWithEmbeddings(
  context: RoutingContext,
  skills: SkillEntry[],
  config: SkillRoutingConfig,
  embeddingProvider: EmbeddingProvider,
): Promise<SkillClassification[]> {
  const useCache = config.dynamic?.embeddings?.cacheEmbeddings ?? true;

  // Build contextual message (include conversation history if available)
  const historyDepth = config.dynamic?.historyDepth ?? 5;
  const history = context.conversationHistory ?? [];
  const recentHistory = history.slice(-historyDepth);
  const contextualMessage = [...recentHistory, context.message].join("\n\n");

  // Generate embedding for the input message
  const messageEmbedding = await embeddingProvider.embedQuery(contextualMessage);

  // Classify each skill
  const classifications: SkillClassification[] = [];

  for (const skill of skills) {
    const routing = getRoutingMetadata(skill);
    const skillDomains = routing.domains ?? [];

    let confidence: number;
    let reason: string | undefined;

    if (routing.alwaysInclude) {
      // Always-include skills get maximum confidence
      confidence = 1.0;
      reason = "alwaysInclude flag";
    } else {
      // Get skill embedding and compute similarity
      const skillEmbedding = await getSkillEmbedding(skill, embeddingProvider, useCache);
      const similarity = cosineSimilarity(messageEmbedding, skillEmbedding);

      // Apply domain weight if set
      const domainWeight = routing.domainWeight ?? 1.0;
      confidence = similarity * domainWeight;
      reason = `embedding similarity: ${similarity.toFixed(3)}`;
    }

    classifications.push({
      skillName: skill.skill.name,
      domains: skillDomains,
      confidence,
      reason,
    });
  }

  // Sort by confidence descending
  return classifications.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Batch classify skills using embeddings for efficiency.
 * Computes all skill embeddings in a single batch call.
 *
 * @param context - Routing context with user message
 * @param skills - Array of eligible skill entries
 * @param config - Routing configuration
 * @param embeddingProvider - Provider for generating embeddings
 * @returns Array of skill classifications sorted by confidence (descending)
 */
export async function classifyWithEmbeddingsBatch(
  context: RoutingContext,
  skills: SkillEntry[],
  config: SkillRoutingConfig,
  embeddingProvider: EmbeddingProvider,
): Promise<SkillClassification[]> {
  const useCache = config.dynamic?.embeddings?.cacheEmbeddings ?? true;

  // Build contextual message
  const historyDepth = config.dynamic?.historyDepth ?? 5;
  const history = context.conversationHistory ?? [];
  const recentHistory = history.slice(-historyDepth);
  const contextualMessage = [...recentHistory, context.message].join("\n\n");

  // Collect skills that need embeddings
  const skillsNeedingEmbeddings: { skill: SkillEntry; text: string; index: number }[] = [];
  const cachedEmbeddings: Map<number, number[]> = new Map();

  for (let i = 0; i < skills.length; i++) {
    const skill = skills[i];
    const routing = getRoutingMetadata(skill);

    if (routing.alwaysInclude) {
      continue; // Skip, will be handled separately
    }

    const cacheKey = `${embeddingProvider.id}:${skill.skill.name}`;
    if (useCache) {
      const cached = skillEmbeddingCache.get(cacheKey);
      if (cached) {
        cachedEmbeddings.set(i, cached);
        continue;
      }
    }

    skillsNeedingEmbeddings.push({
      skill,
      text: buildSkillText(skill),
      index: i,
    });
  }

  // Batch embed message + uncached skills
  const textsToEmbed = [contextualMessage, ...skillsNeedingEmbeddings.map((s) => s.text)];
  const embeddings = await embeddingProvider.embedBatch(textsToEmbed);

  const messageEmbedding = embeddings[0];

  // Cache new skill embeddings
  for (let i = 0; i < skillsNeedingEmbeddings.length; i++) {
    const { skill, index } = skillsNeedingEmbeddings[i];
    const embedding = embeddings[i + 1];
    const cacheKey = `${embeddingProvider.id}:${skill.skill.name}`;

    if (useCache) {
      skillEmbeddingCache.set(cacheKey, embedding);
    }
    cachedEmbeddings.set(index, embedding);
  }

  // Build classifications
  const classifications: SkillClassification[] = [];

  for (let i = 0; i < skills.length; i++) {
    const skill = skills[i];
    const routing = getRoutingMetadata(skill);
    const skillDomains = routing.domains ?? [];

    let confidence: number;
    let reason: string | undefined;

    if (routing.alwaysInclude) {
      confidence = 1.0;
      reason = "alwaysInclude flag";
    } else {
      const skillEmbedding = cachedEmbeddings.get(i);
      if (!skillEmbedding) {
        confidence = 0.1;
        reason = "embedding not available";
      } else {
        const similarity = cosineSimilarity(messageEmbedding, skillEmbedding);
        const domainWeight = routing.domainWeight ?? 1.0;
        confidence = similarity * domainWeight;
        reason = `embedding similarity: ${similarity.toFixed(3)}`;
      }
    }

    classifications.push({
      skillName: skill.skill.name,
      domains: skillDomains,
      confidence,
      reason,
    });
  }

  return classifications.sort((a, b) => b.confidence - a.confidence);
}
