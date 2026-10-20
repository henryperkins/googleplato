import { Component, createRef } from 'react';
import { Button } from '@/components/ui/button';

/**
 * Catches render errors below it so a broken view shows a recovery screen
 * instead of a blank page. That includes a lazy admin chunk that fails to load
 * after a deploy, which a reload fixes. `resetKey` (the current path) clears
 * the error when the visitor navigates elsewhere.
 */
export default class ErrorBoundary extends Component {
  state = { error: null };

  headingRef = createRef();

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[plato] render error', error, info?.componentStack);
  }

  componentDidUpdate(prevProps, prevState) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
      return;
    }
    // Announce the failure by moving focus to its heading.
    if (this.state.error && !prevState.error) this.headingRef.current?.focus();
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <main className="min-h-dvh shrink-0 flex flex-col items-center justify-center gap-3 p-4 text-center">
        <h1 ref={this.headingRef} tabIndex={-1} className="text-xl font-semibold">Something went wrong</h1>
        <p className="max-w-sm text-sm text-muted-foreground">This page hit an unexpected error. Reload to try again.</p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button onClick={() => window.location.reload()}>Reload page</Button>
          <Button variant="outline" nativeButton={false} render={<a href="/lessons" />}>Go to lessons</Button>
        </div>
      </main>
    );
  }
}
