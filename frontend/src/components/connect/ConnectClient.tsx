/* =============================================================================
   ConnectClient — extension download, pairing, live bridge status
   -----------------------------------------------------------------------------
   Three jobs, none of which has a demo fixture:

   * The **extension download**: a real ZIP produced by `npm run build` in
     `browser-extension/`, served from this site's `/downloads` folder.
   * `GET /api/browser/status` — the bridge configuration and the browsers
     currently connected, shown live (5s poll) so a browser that just paired
     appears without a manual refresh. It also carries the socket URLs the
     extension popup can be pointed at.
   * `POST /api/browser/pairing` — mint a short-lived, single-use code that the
     user copies into the extension popup.

   This page inherently needs a live backend: pairing is a real handshake, so
   nothing here is ever fabricated or stubbed. The download is served statically
   and therefore works even before the backend is up.
   ============================================================================= */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { CopyButton } from "@/components/ui/CopyButton";
import { Badge } from "@/components/ui/StatusBadge";
import { ErrorState } from "@/components/ui/States";
import { AnimatedAnchor, AnimatedButton } from "@/components/ui/AnimatedButton";
import { API_CONFIG } from "@/lib/config";
import { mintPairingCode, fetchBridgeStatus, type BridgeStatus, type PairingDraft } from "@/lib/api/browser";
import { formatDateTime } from "@/lib/utils/format";
import type { WebSocketUrlDto } from "@/types/api";
import { AlertIcon, DownloadIcon, GlobeIcon, LinkIcon, RefreshIcon } from "@/components/ui/icons";
import styles from "./ConnectClient.module.css";

const POLL_MS = 5_000;

/** Real artifact written by the extension packaging step. */
const EXTENSION_ZIP = "/downloads/AgentWebEinh-Chrome-Extension.zip";

export function ConnectClient(): React.JSX.Element {
  return (
    <div className={styles.root}>
      <DownloadSection />
      {API_CONFIG.mode === "demo" ? <DemoNotice /> : <PairingPanel />}
    </div>
  );
}

/* ---------------------------------------------------------------- demo gate -- */

function DemoNotice(): React.JSX.Element {
  return (
    <div className="bw-panel">
      <div className={styles.gate}>
        <AlertIcon size={18} />
        <div>
          <p className={styles.gateTitle}>Pairing needs a live backend</p>
          <p className={styles.gateBody}>
            AgentWebEinh is running in demo mode, which has no backend to handshake with. Start the
            backend, switch to live mode from the header, and this page will mint real pairing codes.
          </p>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ download card -- */

function DownloadSection(): React.JSX.Element {
  return (
    <section className={styles.section} aria-label="Download the Chrome extension">
      <div className={`bw-panel ${styles.panel}`}>
        <div className={styles.panelHead}>
          <span className={styles.panelIcon} aria-hidden="true">
            <DownloadIcon size={16} />
          </span>
          <div>
            <h2 className={styles.panelTitle}>1 · Download the Chrome extension</h2>
            <p className={styles.panelBody}>
              Extract the ZIP somewhere permanent, then open <code>chrome://extensions</code>, turn on{" "}
              <strong>Developer mode</strong>, press <strong>Load unpacked</strong> and select the extracted
              <code> AgentWebEinh-Chrome-Extension</code> folder. Pin the extension so its popup is one click away.
            </p>
          </div>
        </div>
        <div className={styles.actionRow}>
          <AnimatedAnchor
            href={EXTENSION_ZIP}
            label="Download Chrome Extension"
            download="AgentWebEinh-Chrome-Extension.zip"
            icon={<DownloadIcon size={15} />}
          />
          <p className={styles.muted}>Manifest V3 · connects over a WebSocket · no store listing required</p>
        </div>
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- main panel -- */

function PairingPanel(): React.JSX.Element {
  const [status, setStatus] = useState<BridgeStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);

  const [draft, setDraft] = useState<PairingDraft | null>(null);
  const [minting, setMinting] = useState(false);
  const [mintError, setMintError] = useState<string | null>(null);

  const [pairedFlash, setPairedFlash] = useState<string | null>(null);
  const lastPeers = useRef<Set<string>>(new Set());

  const loadStatus = useCallback(async (signal?: AbortSignal) => {
    try {
      const next = await fetchBridgeStatus(signal);
      setStatus(next);
      setStatusError(null);
      const before = lastPeers.current;
      if (before.size > 0) {
        const fresh = next.peers.filter((peer) => !before.has(peer.browserId));
        if (fresh.length > 0) {
          setPairedFlash(`Paired: ${fresh.map((peer) => peer.name).join(", ")}`);
        }
      }
      lastPeers.current = new Set(next.peers.map((peer) => peer.browserId));
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : "Could not reach the browser bridge.");
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void loadStatus(controller.signal);
    const timer = setInterval(() => void loadStatus(), POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [loadStatus]);

  useEffect(() => {
    if (!pairedFlash) return;
    const timer = setTimeout(() => setPairedFlash(null), 6_000);
    return () => clearTimeout(timer);
  }, [pairedFlash]);

  const mint = useCallback(async () => {
    setMinting(true);
    setMintError(null);
    setDraft(null);
    setPairedFlash(null);
    try {
      const next = await mintPairingCode();
      setDraft(next);
    } catch (error) {
      setMintError(error instanceof Error ? error.message : "The backend did not mint a pairing code.");
    } finally {
      setMinting(false);
    }
  }, []);

  const socketUrls: WebSocketUrlDto[] = draft?.websocketUrls?.length
    ? draft.websocketUrls
    : (status?.websocketUrls ?? []);

  return (
    <>
      <section className={styles.section} aria-label="Generate a pairing code">
        <div className={`bw-panel ${styles.panel}`}>
          <div className={styles.panelHead}>
            <span className={styles.panelIcon} aria-hidden="true">
              <LinkIcon size={16} />
            </span>
            <div>
              <h2 className={styles.panelTitle}>2 · Generate a code</h2>
              <p className={styles.panelBody}>
                A code is single-use and expires {draft?.ttlSeconds != null ? formatSeconds(draft.ttlSeconds) : "within minutes"}.
              </p>
            </div>
          </div>

          <div className={styles.actionRow}>
            <AnimatedButton label={draft ? "Generate another code" : "Generate pairing code"} size="md" onClick={() => void mint()} />
            {minting ? <p className={styles.muted}>Minting a fresh code…</p> : null}
          </div>
          {mintError ? (
            <p className={styles.errorText} role="alert">
              {mintError}
            </p>
          ) : null}

          {draft ? (
            <div className={styles.codeCard}>
              <div className={styles.codeRow}>
                <code className={styles.code}>{draft.code}</code>
                <CopyButton value={draft.code} label="Copy code" />
              </div>
              <p className={styles.codeMeta}>
                {draft.expiresAt ? <>Expires {formatDateTime(draft.expiresAt)}.</> : null}{" "}
                {draft.websocketEndpoint ? <span>Socket path: {draft.websocketEndpoint}</span> : null}
              </p>
            </div>
          ) : null}
        </div>
      </section>

      <section className={styles.section} aria-label="Pair the extension">
        <div className={`bw-panel ${styles.panel}`}>
          <div className={styles.panelHead}>
            <span className={styles.panelIcon} aria-hidden="true">
              <GlobeIcon size={16} />
            </span>
            <div>
              <h2 className={styles.panelTitle}>3 · Pair your browser</h2>
              <p className={styles.panelBody}>
                Open the AgentWebEinh extension popup. If the backend URL field does not already match one of
                the addresses below, paste the right one in, then paste the code and press{" "}
                <strong>Pair browser</strong>. The popup turns green and this page lists the browser under
                &ldquo;Paired browsers&rdquo;.
              </p>
            </div>
          </div>

          {socketUrls.length > 0 ? (
            <ul className={styles.urlList}>
              {socketUrls.map((entry) => (
                <li key={entry.url} className={styles.urlRow}>
                  <div className={styles.urlMain}>
                    <p className={styles.urlLabel}>{entry.label}</p>
                    <p className={styles.urlValue}>
                      <code>{entry.url}</code>
                    </p>
                    {entry.note ? <p className={styles.urlNote}>{entry.note}</p> : null}
                  </div>
                  <CopyButton value={entry.url} label={`Copy ${entry.label} URL`} />
                </li>
              ))}
            </ul>
          ) : (
            <p className={styles.muted}>The backend did not advertise a socket address yet.</p>
          )}
        </div>
      </section>

      <section className={styles.section} aria-label="Paired browsers">
        <div className={`bw-panel ${styles.panel}`}>
          <div className={styles.panelHead}>
            <span className={styles.panelIcon} aria-hidden="true">
              <GlobeIcon size={16} />
            </span>
            <div>
              <h2 className={styles.panelTitle}>4 · Paired browsers</h2>
              <p className={styles.panelBody}>
                {statusLoading
                  ? "Checking the bridge…"
                  : status
                    ? bridgeConfigLine(status)
                    : "The bridge did not answer, so the list below is blank."}
              </p>
            </div>
            <AnimatedButton label="Refresh" size="sm" variant="quiet" icon={<RefreshIcon size={14} />} onClick={() => void loadStatus()} />
          </div>

          {pairedFlash ? (
            <p className={styles.successText} role="status">
              {pairedFlash}
            </p>
          ) : null}

          {statusError && !statusLoading ? (
            <ErrorState title="Pairing unavailable" message={statusError} onRetry={() => void loadStatus()} compact />
          ) : null}

          {statusLoading ? (
            <p className={styles.muted}>Loading paired browsers…</p>
          ) : null}

          {status && status.peers.length === 0 && !statusError ? (
            <p className={styles.muted}>No browser is paired yet. Mint a code above and use it in the extension popup.</p>
          ) : null}

          {status && status.peers.length > 0 ? (
            <ul className={styles.peerList}>
              {status.peers.map((peer) => (
                <li key={peer.browserId} className={styles.peerRow}>
                  <div className={styles.peerMain}>
                    <p className={styles.peerName}>{peer.name}</p>
                    <p className={styles.peerMeta}>
                      <code>{peer.browserId}</code>
                      {peer.connectedAt ? <> · connected {formatDateTime(peer.connectedAt)}</> : null}
                    </p>
                  </div>
                  <Badge tone={peer.busy ? "warning" : "success"}>{peer.busy ? "In use" : "Available"}</Badge>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </section>
    </>
  );
}

/* --------------------------------------------------------------- helpers -- */

function bridgeConfigLine(status: BridgeStatus): string {
  if (!status.enabled) return "disabled in backend settings";
  if (!status.agentMode) return "accepts pairings, but tasks still use the built-in browser engine";
  return "routing every task through a paired browser";
}

function formatSeconds(total: number): string {
  if (total >= 60) return `within ${Math.round(total / 60)} minutes`;
  return `within ${total} seconds`;
}
