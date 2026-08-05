/**
 * Intent schemas (PRD §13.3). Zod-validated at the SDK boundary.
 */
import { z } from "zod";
export declare const ASTDeltaSchema: z.ZodObject<{
    filePath: z.ZodString;
    type: z.ZodEnum<["ADDED", "MODIFIED", "DELETED", "MOVED", "RENAMED"]>;
    nodeIds: z.ZodArray<z.ZodString, "many">;
    summary: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    filePath: string;
    type: "ADDED" | "MODIFIED" | "DELETED" | "MOVED" | "RENAMED";
    nodeIds: string[];
    summary?: string | undefined;
}, {
    filePath: string;
    type: "ADDED" | "MODIFIED" | "DELETED" | "MOVED" | "RENAMED";
    nodeIds: string[];
    summary?: string | undefined;
}>;
export declare const AuthorSchema: z.ZodObject<{
    type: z.ZodEnum<["HUMAN", "AGENT"]>;
    identifier: z.ZodString;
    model: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    type: "HUMAN" | "AGENT";
    identifier: string;
    model?: string | undefined;
}, {
    type: "HUMAN" | "AGENT";
    identifier: string;
    model?: string | undefined;
}>;
export declare const IntentSchema: z.ZodObject<{
    id: z.ZodString;
    parentId: z.ZodOptional<z.ZodNullable<z.ZodString>>;
    gitCommitSha: z.ZodString;
    author: z.ZodObject<{
        type: z.ZodEnum<["HUMAN", "AGENT"]>;
        identifier: z.ZodString;
        model: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        type: "HUMAN" | "AGENT";
        identifier: string;
        model?: string | undefined;
    }, {
        type: "HUMAN" | "AGENT";
        identifier: string;
        model?: string | undefined;
    }>;
    prompt: z.ZodString;
    astDelta: z.ZodArray<z.ZodObject<{
        filePath: z.ZodString;
        type: z.ZodEnum<["ADDED", "MODIFIED", "DELETED", "MOVED", "RENAMED"]>;
        nodeIds: z.ZodArray<z.ZodString, "many">;
        summary: z.ZodOptional<z.ZodString>;
    }, "strip", z.ZodTypeAny, {
        filePath: string;
        type: "ADDED" | "MODIFIED" | "DELETED" | "MOVED" | "RENAMED";
        nodeIds: string[];
        summary?: string | undefined;
    }, {
        filePath: string;
        type: "ADDED" | "MODIFIED" | "DELETED" | "MOVED" | "RENAMED";
        nodeIds: string[];
        summary?: string | undefined;
    }>, "many">;
    agentState: z.ZodOptional<z.ZodString>;
    verifyCmd: z.ZodOptional<z.ZodString>;
    timestamp: z.ZodNumber;
    signature: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    id: string;
    gitCommitSha: string;
    author: {
        type: "HUMAN" | "AGENT";
        identifier: string;
        model?: string | undefined;
    };
    prompt: string;
    astDelta: {
        filePath: string;
        type: "ADDED" | "MODIFIED" | "DELETED" | "MOVED" | "RENAMED";
        nodeIds: string[];
        summary?: string | undefined;
    }[];
    timestamp: number;
    parentId?: string | null | undefined;
    agentState?: string | undefined;
    verifyCmd?: string | undefined;
    signature?: string | undefined;
}, {
    id: string;
    gitCommitSha: string;
    author: {
        type: "HUMAN" | "AGENT";
        identifier: string;
        model?: string | undefined;
    };
    prompt: string;
    astDelta: {
        filePath: string;
        type: "ADDED" | "MODIFIED" | "DELETED" | "MOVED" | "RENAMED";
        nodeIds: string[];
        summary?: string | undefined;
    }[];
    timestamp: number;
    parentId?: string | null | undefined;
    agentState?: string | undefined;
    verifyCmd?: string | undefined;
    signature?: string | undefined;
}>;
export declare const RealizeRequestSchema: z.ZodObject<{
    prompt: z.ZodString;
    files: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    model: z.ZodOptional<z.ZodString>;
    author: z.ZodOptional<z.ZodString>;
    authorType: z.ZodOptional<z.ZodEnum<["HUMAN", "AGENT"]>>;
    agentState: z.ZodOptional<z.ZodString>;
    verifyCmd: z.ZodOptional<z.ZodString>;
    noAst: z.ZodOptional<z.ZodBoolean>;
}, "strip", z.ZodTypeAny, {
    prompt: string;
    model?: string | undefined;
    author?: string | undefined;
    agentState?: string | undefined;
    verifyCmd?: string | undefined;
    files?: string[] | undefined;
    authorType?: "HUMAN" | "AGENT" | undefined;
    noAst?: boolean | undefined;
}, {
    prompt: string;
    model?: string | undefined;
    author?: string | undefined;
    agentState?: string | undefined;
    verifyCmd?: string | undefined;
    files?: string[] | undefined;
    authorType?: "HUMAN" | "AGENT" | undefined;
    noAst?: boolean | undefined;
}>;
export declare const BlameRequestSchema: z.ZodObject<{
    file: z.ZodString;
    line: z.ZodOptional<z.ZodNumber>;
    functionName: z.ZodOptional<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    file: string;
    line?: number | undefined;
    functionName?: string | undefined;
}, {
    file: string;
    line?: number | undefined;
    functionName?: string | undefined;
}>;
export declare const ContextRequestSchema: z.ZodObject<{
    file: z.ZodString;
    limit: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    file: string;
    limit?: number | undefined;
}, {
    file: string;
    limit?: number | undefined;
}>;
export declare const LogRequestSchema: z.ZodObject<{
    author: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
    file: z.ZodOptional<z.ZodString>;
    limit: z.ZodOptional<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    model?: string | undefined;
    author?: string | undefined;
    file?: string | undefined;
    limit?: number | undefined;
}, {
    model?: string | undefined;
    author?: string | undefined;
    file?: string | undefined;
    limit?: number | undefined;
}>;
export type ASTDelta = z.infer<typeof ASTDeltaSchema>;
export type Author = z.infer<typeof AuthorSchema>;
export type Intent = z.infer<typeof IntentSchema>;
export type RealizeRequest = z.infer<typeof RealizeRequestSchema>;
export type BlameRequest = z.infer<typeof BlameRequestSchema>;
export type ContextRequest = z.infer<typeof ContextRequestSchema>;
export type LogRequest = z.infer<typeof LogRequestSchema>;
//# sourceMappingURL=schema.d.ts.map