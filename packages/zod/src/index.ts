/**
 * `@egon-orm/zod`: Zod schemas derived from Egon schema classes.
 *
 * @module
 */

export { castWith } from "./cast-with.js";
export type { ToZodKeys, ToZodMode, ToZodOptions, ToZodShape, ZodHint } from "./to-zod.js";
export { toZod } from "./to-zod.js";

/**
 * The version of the `@egon-orm/zod` package.
 *
 * @example
 * ```ts
 * import { VERSION } from "@egon-orm/zod";
 *
 * console.log(VERSION); // "0.1.0"
 * ```
 */
export const VERSION: string = "0.1.0";
