import { z } from "zod";

/*
 * What Polymath's capture endpoint accepts as a supplied YouTube transcript,
 * copied from `src/domains/knowledge/youtube-transcript-schema.ts` in the
 * Polymath repo when the extension moved out of it. The extension is tested
 * against this copy; when the server's bounds change, change them here too.
 */

const MAX_CUES = 20_000;
const MAX_CUE_TEXT = 2_000;
const MAX_TRANSCRIPT_CHARS = 600_000;

export const suppliedTranscriptSchema = z
  .object({
    videoId: z.string().regex(/^[A-Za-z0-9_-]{11}$/),
    title: z.string().max(500).nullable().optional(),
    language: z.string().max(20).nullable().optional(),
    generated: z.boolean().optional(),
    cues: z
      .array(
        z.object({
          start: z.number().finite().min(0).max(86_400),
          duration: z.number().finite().min(0).max(86_400),
          text: z.string().min(1).max(MAX_CUE_TEXT),
        }),
      )
      .min(1)
      .max(MAX_CUES),
  })
  .refine((value) => value.cues.reduce((sum, cue) => sum + cue.text.length, 0) <= MAX_TRANSCRIPT_CHARS);
