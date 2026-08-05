/**
 * The two pieces of real interactive state on this site: the step control and
 * the click-to-reveal explorer. Static markup is deliberately not tested — it
 * churns with every diagram tweak and catches nothing.
 *
 * Preact batches state updates, so every assertion after a click polls with
 * vi.waitFor rather than reading the DOM synchronously (same as web/'s tests).
 */
import { render } from 'preact';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Explorer, Stepper, type Step } from './kit';

const STEPS: Step[] = [
  { id: 'one', label: 'One', detail: <p>first detail</p> },
  { id: 'two', label: 'Two', detail: <p>second detail</p> },
  { id: 'three', label: 'Three', detail: <p>third detail</p> },
];

function mountStepper(): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  render(
    <Stepper caption="Test flow" steps={STEPS}>
      {(index) => <span data-testid="stage">stage {index}</span>}
    </Stepper>,
    host,
  );
  return host;
}

function buttonByText(host: HTMLElement, text: string): HTMLButtonElement {
  const found = [...host.querySelectorAll('button')].find((element) =>
    (element.textContent ?? '').includes(text),
  );
  if (found === undefined) throw new Error(`No button containing "${text}"`);
  return found;
}

function stage(host: HTMLElement): string {
  return host.querySelector('[data-testid="stage"]')?.textContent ?? '';
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('Stepper', () => {
  it('starts on the first step', () => {
    const host = mountStepper();
    expect(stage(host)).toBe('stage 0');
    expect(host.querySelector('.stepper-detail')?.textContent).toContain('first detail');
    expect(host.querySelector('.stepper-detail-head')?.textContent).toContain('Step 1 of 3');
  });

  it('advances and rewinds, passing the index to the stage', async () => {
    const host = mountStepper();
    buttonByText(host, 'Next').click();
    await vi.waitFor(() => {
      expect(stage(host)).toBe('stage 1');
    });
    expect(host.querySelector('.stepper-detail')?.textContent).toContain('second detail');

    buttonByText(host, 'Previous').click();
    await vi.waitFor(() => {
      expect(stage(host)).toBe('stage 0');
    });
  });

  it('clamps at both ends', async () => {
    const host = mountStepper();
    expect(buttonByText(host, 'Previous').disabled).toBe(true);

    buttonByText(host, 'Next').click();
    await vi.waitFor(() => {
      expect(stage(host)).toBe('stage 1');
    });
    buttonByText(host, 'Next').click();
    await vi.waitFor(() => {
      expect(stage(host)).toBe('stage 2');
      expect(buttonByText(host, 'Next').disabled).toBe(true);
    });
  });

  it('jumps straight to a step from its dot', async () => {
    const host = mountStepper();
    host.querySelectorAll<HTMLButtonElement>('.stepper-dot')[2]?.click();
    await vi.waitFor(() => {
      expect(stage(host)).toBe('stage 2');
      expect(host.querySelector('.stepper-dot.is-current')?.textContent).toContain('Three');
    });
  });

  it('moves with the arrow keys', async () => {
    const host = mountStepper();
    const stepper = host.querySelector('.stepper');
    stepper?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    await vi.waitFor(() => {
      expect(stage(host)).toBe('stage 1');
    });

    stepper?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await vi.waitFor(() => {
      expect(stage(host)).toBe('stage 0');
    });
  });

  it('marks the current step for assistive technology', () => {
    const host = mountStepper();
    expect(host.querySelector('[aria-current="step"]')?.textContent).toContain('One');
  });
});

describe('Explorer', () => {
  function mountExplorer(): HTMLElement {
    const host = document.createElement('div');
    document.body.appendChild(host);
    render(
      <Explorer
        emptyHint="pick one"
        items={[
          { id: 'a', label: 'Alpha', detail: <p>alpha detail</p> },
          { id: 'b', label: 'Beta', detail: <p>beta detail</p> },
        ]}
      >
        {(selected, select) => (
          <>
            <button
              type="button"
              data-id="a"
              onClick={() => {
                select('a');
              }}
            >
              A{selected === 'a' ? ' (on)' : ''}
            </button>
            <button
              type="button"
              data-id="b"
              onClick={() => {
                select('b');
              }}
            >
              B
            </button>
          </>
        )}
      </Explorer>,
      host,
    );
    return host;
  }

  function click(host: HTMLElement, id: string): void {
    host.querySelector<HTMLButtonElement>(`[data-id="${id}"]`)?.click();
  }

  it('shows the hint until something is selected', () => {
    const host = mountExplorer();
    expect(host.querySelector('.explorer-hint')?.textContent).toBe('pick one');
  });

  it('reveals the selected item and reports selection to the diagram', async () => {
    const host = mountExplorer();
    click(host, 'a');
    await vi.waitFor(() => {
      expect(host.querySelector('.explorer-detail')?.textContent).toContain('alpha detail');
      expect(host.querySelector<HTMLButtonElement>('[data-id="a"]')?.textContent).toContain('(on)');
    });
  });

  it('switches between items', async () => {
    const host = mountExplorer();
    click(host, 'a');
    await vi.waitFor(() => {
      expect(host.querySelector('.explorer-detail')?.textContent).toContain('alpha detail');
    });
    click(host, 'b');
    await vi.waitFor(() => {
      expect(host.querySelector('.explorer-detail')?.textContent).toContain('beta detail');
    });
  });

  it('deselects when the same item is chosen twice', async () => {
    const host = mountExplorer();
    click(host, 'a');
    await vi.waitFor(() => {
      expect(host.querySelector('.explorer-detail')?.textContent).toContain('alpha detail');
    });
    click(host, 'a');
    await vi.waitFor(() => {
      expect(host.querySelector('.explorer-hint')?.textContent).toBe('pick one');
    });
  });
});
