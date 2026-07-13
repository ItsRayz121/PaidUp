"use client";

// One broken panel must not take down the whole staff page.
//
// This exists because it already happened: a display-only USDT stat tile threw
// on render, and with nothing to catch it React unmounted the entire /staff
// tree — including the withdrawal queue. Staff could not pay anyone because a
// number was formatted wrong. Blast radius is now one panel.
import { Component, type ReactNode } from "react";

type Props = { title: string; children: ReactNode };
type State = { error: Error | null };

export class Panel extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    // Internal tool: the console is where staff (and we) will look. Once Sentry
    // is authorized this is the hook to report from.
    console.error(`[staff] panel "${this.props.title}" crashed:`, error);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <section className="mb-8">
        <div className="rounded-lg border border-danger/30 bg-danger-tint/40 p-4">
          <h2 className="font-bold text-brand-ink">{this.props.title} — failed to load</h2>
          <p className="mt-1 text-sm text-muted">
            This panel crashed. The rest of the page still works, so you can keep
            processing withdrawals.
          </p>
          <p className="mt-2 break-all font-mono text-xs text-danger">{error.message}</p>
          <button
            onClick={() => this.setState({ error: null })}
            className="mt-3 rounded-md bg-brand px-3 py-1.5 text-xs font-semibold text-white"
          >
            Retry this panel
          </button>
        </div>
      </section>
    );
  }
}
