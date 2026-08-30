import { z } from 'zod';

/**
 * Local shapes for the parts of the MangaDex API this source actually reads. Not
 * exhaustive of MangaDex's real response — every object type carries far more fields than
 * we use — so `attributes` on the generic relationship shape stays a permissive record:
 * relationships arrive with or without `attributes` depending on whether that type was in
 * the request's `includes[]`, and mixing several relationship types in one array means
 * only the type this code filters for gets its shape narrowed.
 */
export const MangaDexRelationshipSchema = z.object({
  id: z.string(),
  type: z.string(),
  attributes: z.record(z.string(), z.unknown()).optional(),
});
export type MangaDexRelationship = z.infer<typeof MangaDexRelationshipSchema>;

const LocalizedTextSchema = z.record(z.string(), z.string());

export const MangaDexTagSchema = z.object({
  id: z.string(),
  type: z.string(),
  attributes: z.object({
    name: LocalizedTextSchema,
    group: z.string(),
  }),
});
export type MangaDexTag = z.infer<typeof MangaDexTagSchema>;

export const MangaDexTagListResponseSchema = z.object({
  data: z.array(MangaDexTagSchema),
});

export const MangaDexMangaSchema = z.object({
  id: z.string(),
  attributes: z.object({
    title: LocalizedTextSchema,
    description: LocalizedTextSchema.optional(),
    status: z.string().optional(),
    tags: z.array(MangaDexTagSchema),
  }),
  relationships: z.array(MangaDexRelationshipSchema),
});
export type MangaDexManga = z.infer<typeof MangaDexMangaSchema>;

export const MangaDexMangaListResponseSchema = z.object({
  data: z.array(MangaDexMangaSchema),
});

export const MangaDexMangaDetailsResponseSchema = z.object({
  data: MangaDexMangaSchema,
});

export const MangaDexChapterSchema = z.object({
  id: z.string(),
  attributes: z.object({
    chapter: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    translatedLanguage: z.string(),
    pages: z.number().optional(),
    publishAt: z.string().optional(),
  }),
  relationships: z.array(MangaDexRelationshipSchema),
});
export type MangaDexChapter = z.infer<typeof MangaDexChapterSchema>;

export const MangaDexChapterListResponseSchema = z.object({
  data: z.array(MangaDexChapterSchema),
  limit: z.number(),
  offset: z.number(),
  total: z.number(),
});

export const MangaDexAtHomeResponseSchema = z.object({
  baseUrl: z.string(),
  chapter: z.object({
    hash: z.string(),
    data: z.array(z.string()),
  }),
});
