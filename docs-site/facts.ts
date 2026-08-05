/**
 * Typed access to the facts extracted from crew's authoritative modules.
 *
 * `generated/facts.json` is written by `tests/unit/docs-facts.test.ts`, which
 * also fails when it drifts from the registry, the schema, the CLI, or the ADRs.
 * Nothing in this site may restate these values by hand — read them from here.
 */
import raw from './generated/facts.json';

export interface ParticipantFact {
  readonly id: string;
  readonly executable: string;
  readonly minimumVerifiedVersion: string | null;
  readonly verifiedOn: string;
  readonly userPath: string;
  readonly projectPath: string;
  readonly format: string;
  readonly invocation: string;
  readonly permissionNote: string;
  readonly officialSources: readonly string[];
}

export interface BackendFact {
  readonly id: string;
  readonly executable: string;
  readonly minimumVerifiedVersion: string | null;
  readonly verifiedOn: string;
  readonly officialSources: readonly string[];
}

export interface CommandFact {
  readonly name: string;
  readonly description: string;
  readonly subcommands: readonly string[];
}

export interface AdrFact {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
}

export interface Facts {
  readonly package: {
    readonly name: string;
    readonly version: string;
    readonly nodeEngine: string;
    readonly runtimeDependencies: Readonly<Record<string, string>>;
    readonly devDependencies: readonly string[];
  };
  readonly registry: {
    readonly revision: number;
    readonly participants: readonly ParticipantFact[];
    readonly backends: readonly BackendFact[];
  };
  readonly schema: {
    readonly version: number;
    readonly tables: readonly string[];
  };
  readonly coverageThresholds: {
    readonly statements: number;
    readonly branches: number;
    readonly functions: number;
    readonly lines: number;
  };
  readonly commands: readonly CommandFact[];
  readonly adrs: readonly AdrFact[];
}

export const facts: Facts = raw;
