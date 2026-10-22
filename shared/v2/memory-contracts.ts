import {z} from 'zod';
export const memoryTopics=['career','popcorn','business','housing','marriage','programming','city'] as const;
export const memoryStatus=z.enum(['exploring','planned','declared_decision','abandoned','outdated']);
export const memoryRecord=z.object({id:z.string().uuid(),ownerId:z.string().uuid(),topic:z.enum(memoryTopics),type:z.enum(['life_goal','intention','project']),content:z.string().trim().min(1).max(240),status:memoryStatus,source:z.enum(['explicit_user_statement','user_correction']),confidence:z.enum(['high','provisional']),createdAt:z.string().datetime(),updatedAt:z.string().datetime()}).strict();
export const narrativeSchema=z.object({enabled:z.boolean().default(false),noticeAccepted:z.boolean().default(false),records:z.array(memoryRecord).max(30).default([]),tombstones:z.array(z.enum(memoryTopics)).max(7).default([]),style:z.object({signals:z.array(z.enum(['informal','neutral'])).max(6).default([]),explicitStyle:z.boolean().default(false)}).default({signals:[],explicitStyle:false})}).strict();
export const memoryActionSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.literal('enable'),enabled:z.boolean(),noticeAccepted:z.literal(true)}).strict(),
 z.object({kind:z.literal('list')}).strict(),
 z.object({kind:z.literal('delete'),id:z.string().uuid()}).strict(),
 z.object({kind:z.literal('clear')}).strict(),
 z.object({kind:z.literal('edit'),id:z.string().uuid(),content:z.string().trim().min(1).max(240),status:memoryStatus}).strict()
]);
export type Narrative=z.infer<typeof narrativeSchema>;
export type MemoryRecord=z.infer<typeof memoryRecord>;
export type MemoryAction=z.infer<typeof memoryActionSchema>;
// Cloned so no two sessions ever share a default object (some zod versions reuse default references).
export const createNarrative=():Narrative=>structuredClone(narrativeSchema.parse({}));
export const MEMORY_LIMITS={records:30,retrieved:3,contextCharacters:800,retentionMs:30*86400000,extractionCalls:0};
