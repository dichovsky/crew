/** The section registry: the sidebar, the router, and the tests all read this. */
import type { FunctionComponent } from 'preact';
import { Adrs } from './adrs';
import { Concepts } from './concepts';
import { Concurrency } from './concurrency';
import { Launcher } from './launcher';
import { Lifecycle } from './lifecycle';
import { Limits } from './limits';
import { Modes } from './modes';
import { Modules } from './modules';
import { Participants } from './participants';
import { Schema } from './schema';
import { Stack } from './stack';
import { What } from './what';

export type Track = 'using' | 'building';

export interface SectionEntry {
  readonly id: string;
  readonly nav: string;
  readonly track: Track;
  readonly Component: FunctionComponent;
}

export const TRACKS: readonly { id: Track; label: string; blurb: string }[] = [
  { id: 'using', label: 'Using crew', blurb: 'What it does and where its limits are' },
  { id: 'building', label: 'Building crew', blurb: 'How it is put together' },
];

export const SECTIONS: readonly SectionEntry[] = [
  { id: 'what', nav: 'What crew is', track: 'using', Component: What },
  { id: 'concepts', nav: 'Concepts', track: 'using', Component: Concepts },
  { id: 'modes', nav: 'Manual and launched', track: 'using', Component: Modes },
  { id: 'participants', nav: 'Supported CLIs', track: 'using', Component: Participants },
  { id: 'limits', nav: 'Limitations', track: 'using', Component: Limits },
  { id: 'modules', nav: 'Architecture', track: 'building', Component: Modules },
  { id: 'schema', nav: 'State Store', track: 'building', Component: Schema },
  { id: 'concurrency', nav: 'Concurrency', track: 'building', Component: Concurrency },
  { id: 'lifecycle', nav: 'Task lifecycle', track: 'building', Component: Lifecycle },
  { id: 'launcher', nav: 'Launcher and Relay', track: 'building', Component: Launcher },
  { id: 'stack', nav: 'Stack, build, CI', track: 'building', Component: Stack },
  { id: 'adrs', nav: 'Decision record', track: 'building', Component: Adrs },
];

export const DEFAULT_SECTION = 'what';

export function sectionById(id: string): SectionEntry | undefined {
  return SECTIONS.find((section) => section.id === id);
}
