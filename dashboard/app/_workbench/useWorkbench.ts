"use client";

import { useEffect, useMemo, useState } from "react";
import {
  agreementsClient,
  inFlight,
  poll,
  type Agreement,
  type AgreementDetail,
  type AstGraph,
  type Constraints,
  type StackStatus,
} from "@/lib/agreements";
import { staticSource } from "@/lib/adapter/static";
import { sampleGraph, sampleSummary } from "@/lib/workbench";
import { hasGatewaySession, type GatewaySession } from "@/lib/session";

type Loaded = {
  record: AgreementDetail;
  graph: AstGraph | null;
  constraints: Constraints | null;
  graphError: string;
  constraintError: string;
};
const message = (reason: unknown) => (reason instanceof Error ? reason.message : String(reason));

export function useWorkbench(session: GatewaySession, sample: boolean) {
  const client = useMemo(() => agreementsClient(session), [session]);
  const [agreements, setAgreements] = useState<Agreement[]>([]);
  const [id, setId] = useState("");
  const [status, setStatus] = useState<StackStatus | null>(null);
  const [statusError, setStatusError] = useState("");
  const [listError, setListError] = useState("");
  const [listLoading, setListLoading] = useState(true);
  const [detailError, setDetailError] = useState("");
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [revision, setRevision] = useState(0);
  const [syncedAt, setSyncedAt] = useState("");
  useEffect(() => {
    setAgreements([]);
    setId("");
    setLoaded(null);
    setListError("");
    setDetailError("");
    setStatus(null);
    setStatusError("");
    setListLoading(true);
  }, [sample]);
  useEffect(() => {
    if (!sample && !hasGatewaySession(session)) {
      setListLoading(false);
      return;
    }
    return poll(
      async (signal) => (sample ? (await staticSource.profiles()).map(sampleSummary) : client.list(signal)),
      (records) => {
        setAgreements(records);
        setListError("");
        setListLoading(false);
        setId((current) =>
          records.some((record) => record.id === current)
            ? current
            : ((sample
                ? records.find(
                    (record) =>
                      record.profile ===
                      (new URLSearchParams(window.location.search).get("profile") ?? "rwa-secondary")
                  )?.id
                : null) ??
              records[0]?.id ??
              "")
        );
      },
      (error) => {
        setListError(error.message);
        setListLoading(false);
      },
      (records) => (records.some((record) => inFlight(record.status)) ? 2000 : 15000)
    );
  }, [client, sample, revision, session]);
  useEffect(() => {
    if (sample || !hasGatewaySession(session)) return;
    return poll(
      (signal) => client.status(signal),
      (value) => {
        setStatus(value);
        setStatusError("");
      },
      (error) => {
        setStatus(null);
        setStatusError(error.message);
      },
      () => 15000
    );
  }, [client, sample, revision, session]);
  useEffect(() => {
    setDetailError("");
    if (!id) return;
    return poll<Loaded>(
      async (signal) => {
        if (sample) {
          const summary = agreements.find((record) => record.id === id);
          if (!summary) throw new Error("Sample not found.");
          const policy = await staticSource.policy(summary.profile);
          return {
            record: {
              ...summary,
              source: policy.source,
              policyHash: policy.policyHash,
              clauseTableHash: policy.clauseTableHash,
              export: policy,
            },
            graph: sampleGraph(policy),
            constraints: null,
            graphError: "",
            constraintError: "",
          };
        }
        const record = await client.get(id, signal);
        const [graph, constraints] = await Promise.allSettled([
          record.ast || record.policyHash ? client.ast(id, signal) : Promise.resolve(null),
          record.export ? client.constraints(id, signal) : Promise.resolve(null),
        ]);
        return {
          record,
          graph: graph.status === "fulfilled" ? graph.value : null,
          constraints: constraints.status === "fulfilled" ? constraints.value : null,
          graphError: graph.status === "rejected" ? message(graph.reason) : "",
          constraintError: constraints.status === "rejected" ? message(constraints.reason) : "",
        };
      },
      (value) => {
        setLoaded(value);
        setDetailError("");
        setSyncedAt(new Date().toLocaleTimeString());
        setAgreements((records) => records.map((record) => (record.id === id ? value.record : record)));
      },
      (error) => setDetailError(error.message),
      (value) => (inFlight(value.record.status) ? 2000 : 10000)
    );
    // List updates do not restart the detail poll. Each selection is resolved from the current list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, id, sample, revision]);
  const refresh = () => setRevision((value) => value + 1);
  const acceptMutation = (record: Agreement) => {
    setAgreements((records) => [record, ...records.filter((entry) => entry.id !== record.id)]);
    setLoaded((current) => {
      if (!current || current.record.id !== record.id) return null;
      const samePolicy = !!record.policyHash && record.policyHash === current.record.policyHash;
      return {
        record: { ...record, export: samePolicy ? current.record.export : null },
        graph: samePolicy ? current.graph : null,
        constraints: null,
        graphError: "",
        constraintError: "",
      };
    });
    setId(record.id);
    refresh();
  };
  return {
    client,
    agreements,
    id,
    setId,
    status,
    statusError,
    listError,
    listLoading,
    detailError,
    data: loaded?.record.id === id ? loaded : null,
    refresh,
    acceptMutation,
    syncedAt,
  };
}
