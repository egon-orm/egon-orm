// Setup file of mutation runs only (vitest.mutation.config.ts, owner decision 2026-10-24):
// every fast-check property runs from one fixed seed, so that a property kills the same
// mutants in every run and a mutation run can be repeated exactly. Normal test runs stay
// unseeded: each run tries new inputs.
import fc from "fast-check";

/** The seed of every property in a mutation run. Any fixed integer would do. */
const MUTATION_SEED = 20261024;

fc.configureGlobal({ ...fc.readConfigureGlobal(), seed: MUTATION_SEED });
