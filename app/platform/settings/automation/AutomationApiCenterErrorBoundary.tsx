"use client";

import React from "react";

type Props = {
  children: React.ReactNode;
};

type State = {
  error: Error | null;
};

export class AutomationApiCenterErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error("[AutomationApiCenterErrorBoundary]", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="mx-auto max-w-3xl rounded-xl border border-destructive/40 bg-destructive/10 px-4 py-6 text-sm text-destructive">
          <p className="font-semibold">Automation settings failed to render</p>
          <p className="mt-2 text-xs opacity-90">{this.state.error.message}</p>
          <button
            type="button"
            className="mt-4 rounded-lg border border-destructive/50 bg-background px-3 py-1.5 text-xs font-medium text-foreground hover:bg-muted"
            onClick={() => this.setState({ error: null })}
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
