/**
 * Doctor health list for the Operations view: one row per finding (severity
 * dot + title + detail + tag). Pure render from the /api/health response shape.
 * The view types are shared with the App and Overview.
 */
import { pillBg } from '../view-model.js';

export interface HealthFindingView {
  readonly severity: string;
  readonly code: string;
  readonly message: string;
}

export interface HealthSummaryView {
  readonly ok: boolean;
  readonly info: number;
  readonly warn: number;
  readonly error: number;
  readonly workspace: string | null;
}

export interface HealthState {
  readonly findings: readonly HealthFindingView[];
  readonly summary: HealthSummaryView;
}

interface SeverityStyle {
  readonly dot: string;
  readonly bg: string;
  readonly fg: string;
  readonly tag: string;
}

const SEVERITY: Record<string, SeverityStyle> = {
  error: { dot: '#d15540', bg: '#fbece9', fg: '#a0352c', tag: 'ERROR' },
  warn: { dot: '#d99a2b', bg: '#fbf1de', fg: '#b07d14', tag: 'WARN' },
  info: { dot: '#3b5bd9', bg: '#e8f1fd', fg: '#1f6fd6', tag: 'INFO' },
  ok: { dot: '#27a05f', bg: '#e6f4ec', fg: '#1f8a53', tag: 'OK' },
};

function severityStyle(severity: string, dark: boolean): SeverityStyle {
  const style = SEVERITY[severity] ?? SEVERITY['info']!;
  return { ...style, bg: pillBg(style.bg, style.fg, dark) };
}

export interface HealthListProps {
  readonly findings: readonly HealthFindingView[];
  readonly dark: boolean;
}

export function HealthList({ findings, dark }: HealthListProps) {
  if (findings.length === 0) {
    return <p class="empty-state">No findings — the workspace is healthy.</p>;
  }
  return (
    <div>
      {findings.map((finding) => {
        const style = severityStyle(finding.severity, dark);
        return (
          <div class="health-row" key={`${finding.code}:${finding.message}`}>
            <span class="dot" style={{ background: style.dot, marginTop: '4px' }} />
            <div style={{ flex: 1 }}>
              <div class="health-title">{finding.code}</div>
              <div class="health-detail">{finding.message}</div>
            </div>
            <span class="pill" style={{ background: style.bg, color: style.fg }}>
              {style.tag}
            </span>
          </div>
        );
      })}
    </div>
  );
}
