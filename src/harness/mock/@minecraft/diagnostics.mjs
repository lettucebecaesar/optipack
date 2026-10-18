/**
 * Permissive stub of @minecraft/diagnostics@1.0.0-beta.1.21.70-preview.22 for the differential harness.
 * Generated from the module's real index.d.ts (see test/update-mock-stubs.mjs).
 * Every runtime export is a permissive value: callable, constructable, and
 * chainable; calls and constructions record harness effects so differential
 * equivalence holds. NOT a behavioral model of the engine module.
 */
import { permissive } from '../permissive.mjs';

export const Sentry = permissive('diagnostics.Sentry');
export const SentryAlreadyInitializedError = permissive('diagnostics.SentryAlreadyInitializedError');
export const SentryBreadcrumbLevel = permissive('diagnostics.SentryBreadcrumbLevel');
export const SentryUninitializedError = permissive('diagnostics.SentryUninitializedError');
export const sentry = permissive('diagnostics.sentry');
