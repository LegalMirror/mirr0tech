"use client";

import { useEffect, useState } from "react";
import { source } from "./adapter";

export type Resource<T> = { data: T | undefined; error: Error | undefined; loading: boolean };

/** Load from the data source, and load again whenever a mutation reports a change. */
export function useResource<T>(load: () => Promise<T>, deps: unknown[]): Resource<T> {
  const [state, setState] = useState<Resource<T>>({ data: undefined, error: undefined, loading: true });
  const [version, setVersion] = useState(0);
  useEffect(() => source.subscribe(() => setVersion((v) => v + 1)), []);
  useEffect(() => {
    let live = true;
    setState((prev) => ({ ...prev, loading: true }));
    load().then(
      (data) => live && setState({ data, error: undefined, loading: false }),
      (error: Error) => live && setState({ data: undefined, error, loading: false })
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, version]);
  return state;
}
