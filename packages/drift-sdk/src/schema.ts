/**
 * Intent schemas (PRD §13.3). Zod-validated at the SDK boundary.
 */

import { z } from "zod";

export const ASTDeltaSchema = z.object({
  filePath: z.string(),
  type: z.enum(["ADDED", "MODIFIED", "DELETED", "MOVED", "RENAMED"]),
  nodeIds: z.array(z.string()),
  summary: z.string().optional(),
});

export const AuthorSchema = z.object({
  type: z.enum(["HUMAN", "AGENT"]),
  identifier: z.string(),
  model: z.string().optional(),
});

export const IntentSchema = z.object({
  id: z.string().regex(/^did_[0-9a-f]{32}$/),
  parentId: z.string().regex(/^did_[0-9a-f]{32}$/).nullable().optional(),
  gitCommitSha: z.string().length(40),
  author: AuthorSchema,
  prompt: z.string(),
  astDelta: z.array(ASTDeltaSchema),
  agentState: z.string().optional(),
  verifyCmd: z.string().optional(),
  timestamp: z.number(),
  signature: z.string().optional(),
});

export const RealizeRequestSchema = z.object({
  prompt: z.string().min(1),
  files: z.array(z.string()).optional(),
  model: z.string().optional(),
  author: z.string().optional(),
  authorType: z.enum(["HUMAN", "AGENT"]).optional(),
  agentState: z.string().optional(),
  verifyCmd: z.string().optional(),
  noAst: z.boolean().optional(),
});

export const BlameRequestSchema = z.object({
  file: z.string(),
  line: z.number().int().positive().optional(),
  functionName: z.string().optional(),
});

export const ContextRequestSchema = z.object({
  file: z.string(),
  limit: z.number().int().positive().max(100).optional(),
});

export const LogRequestSchema = z.object({
  author: z.string().optional(),
  model: z.string().optional(),
  file: z.string().optional(),
  limit: z.number().int().positive().max(1000).optional(),
});

export type ASTDelta = z.infer<typeof ASTDeltaSchema>;
export type Author = z.infer<typeof AuthorSchema>;
export type Intent = z.infer<typeof IntentSchema>;
export type RealizeRequest = z.infer<typeof RealizeRequestSchema>;
export type BlameRequest = z.infer<typeof BlameRequestSchema>;
export type ContextRequest = z.infer<typeof ContextRequestSchema>;
export type LogRequest = z.infer<typeof LogRequestSchema>;
