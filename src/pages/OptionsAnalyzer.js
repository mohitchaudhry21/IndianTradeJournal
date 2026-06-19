import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useJournal } from '../context/JournalContext';
import { fetchOptionChain, fetchAngelOneLtp, angelOneLtpKey, toNseSymbol } from '../utils/optionChain';
import { generateMarketTimestamps } from '../utils/marketHours';
import { fetchTickerQuotes } from '../utils/tickerQuotes';
import { isMarketOpen, saveAnalysisSnapshot, loadAnalysisSnapshot } from '../utils/marketHours';
import {
  payoffAt, intrinsicAt, netPremium, findBreakevens,
  positionGreeks, maxProfitLoss, impliedFuturesPrice, standardDeviation,
} from '../utils/optionsAnalysis';

const RISK_FREE_RATE = 0.065;

// Defensive formatting — broker APIs occasionally return numeric fields as
// strings or omit them entirely, and a bare .toFixed() call on anything
// non-numeric crashes the whole page rather than degrading gracefully.
function fmt(value, decimals = 2) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n.toFixed(decimals) : '—';
}

function fmtMoney(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  const sign = n < 0 ? '-' : '+';
  return `${sign}₹${Math.abs(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function StatCard({ label, value, color }) {
  return (
    <div style={{ background: 'var(--bg-card2)', borderRadius: 8, padding: '10px 12px' }}>
      <div style={{ fontSize: 9, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 3 }}>{label}</div>
      <div style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 600, color: color || 'var(--text-primary)' }}>{value}</div>
    </div>
  );
}

export default function OptionsAnalyzer() {
  const { positions } = useJournal();
  const openPositions = useMemo(() => positions.filter(p => p.status === 'OPEN'), [positions]);

  const [selectedPositionId, setSelectedPositionId] = useState(openPositions[0]?.positionId || null);
  const [checkedLegIds, setCheckedLegIds] = useState(new Set());
  const [chainData, setChainData] = useState({}); // legId -> { ltp, iv, oi }
  const [chainSource, setChainSource] = useState(null); // 'nse' | 'angelone' | null
  const [angelLtpByLeg, setAngelLtpByLeg] = useState({}); // legId -> { ltp, oi }, only populated when chainSource is angelone
  const [loadingChain, setLoadingChain] = useState(false);
  const [chainError, setChainError] = useState(null);

  const [liveSpot, setLiveSpot] = useState(null); // real market spot, refreshed by polling
  const liveSpotRef = useRef(null);
  useEffect(() => { liveSpotRef.current = liveSpot; }, [liveSpot]);
  const [scenarioSpot, setScenarioSpot] = useState(null); // user-dragged target spot, null = follow live
  const [targetTimeMs, setTargetTimeMs] = useState(null); // target datetime, as ms since epoch
  const [sliderIdx, setSliderIdx] = useState(0); // index into marketTimestamps array

  const position = openPositions.find(p => p.positionId === selectedPositionId) || openPositions[0];

  // Reset leg selection + scenario sliders whenever the chosen position changes
  useEffect(() => {
    if (!position) return;
    setCheckedLegIds(new Set(position.legs.map(l => l.id)));
    // null means "follow the live clock" — only a manual drag pins this to
    // a concrete timestamp. Pinning it here on load would freeze the
    // target date at whatever moment the position was opened, silently
    // going stale (and the P&L with it) the longer the page stays open.
    setTargetTimeMs(null);
    setSliderIdx(0);
    setScenarioSpot(null);
  }, [position?.positionId]); // eslint-disable-line

  // Fetch the real current spot price independently of the option chain
  // source — AngelOne's optionGreek response doesn't include an underlying
  // value, so relying on the chain response alone left spot defaulting to
  // a meaningless placeholder (the first leg's strike) whenever NSE failed.
  const [lastUpdated, setLastUpdated] = useState(null);
  const [usingSnapshot, setUsingSnapshot] = useState(false);
  const [snapshotSavedAt, setSnapshotSavedAt] = useState(null);
  const [nowTick, setNowTick] = useState(Date.now());

  // Ticks every second purely to keep the "updated Xs ago" label live —
  // doesn't trigger any network calls itself.
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const secondsAgo = lastUpdated ? Math.max(0, Math.round((nowTick - lastUpdated) / 1000)) : null;

  useEffect(() => {
    if (!position) return;
    let cancelled = false;

    if (!isMarketOpen()) {
      // Market's closed — there's nothing genuinely live to poll, so load
      // whatever was last saved while it was open instead of hitting the
      // broker API with calls it may not handle well post-close.
      const snap = loadAnalysisSnapshot(position.positionId);
      if (snap?.liveSpot) setLiveSpot(snap.liveSpot);
      setUsingSnapshot(true);
      setSnapshotSavedAt(snap?.savedAt ?? null);
      return;
    }
    setUsingSnapshot(false);

    const fetchSpot = () => {
      fetchTickerQuotes([toNseSymbol(position.instrument)]).then(result => {
        if (cancelled) return;
        const quote = result.quotes?.find(q => q.name === toNseSymbol(position.instrument));
        if (quote?.ltp) setLiveSpot(quote.ltp);
      });
    };

    fetchSpot();
    // Refresh the live spot price periodically so the analyzer tracks the
    // market in real time rather than showing a stale snapshot from load.
    const intervalId = setInterval(fetchSpot, 7000);
    return () => { cancelled = true; clearInterval(intervalId); };
  }, [position?.positionId]); // eslint-disable-line

  // Fetch the live option chain for this position's instrument + expiry,
  // matching each leg's strike + optionType to the chain response. Polled
  // on the same cadence as spot so LTP/IV/OI per leg, and everything
  // derived from them (Greeks, P&L tables, payoff curve), stays current.
  const [pollFailing, setPollFailing] = useState(false);

  useEffect(() => {
    if (!position) return;
    let cancelled = false;

    if (!isMarketOpen()) {
      // Market is closed — try AngelOne once for EOD/closing values, then
      // fall back to a saved snapshot. Don't poll; one fetch is enough since
      // prices won't change until next open.
      setUsingSnapshot(true);

      const tryLiveEod = () => {
        const symbol = toNseSymbol(position.instrument);
        setLoadingChain(true);
        fetchOptionChain(symbol, position.expiry, RISK_FREE_RATE).then(result => {
          if (cancelled) return;
          setLoadingChain(false);
          if (result.ok && result.rows?.length) {
            // Got EOD data from AngelOne — use it and save as snapshot
            setChainSource(result.source);
            setChainError(null);
            const byLeg = {};
            const angelLegs = [];
            position.legs.forEach(leg => {
              const row = result.rows.find(r => Math.abs(r.strike - leg.strike) < 0.01);
              const legData = row ? row[leg.optionType] : null;
              if (legData) {
                byLeg[leg.id] = { ltp: legData.ltp, iv: legData.iv, oi: legData.oi };
                if (!legData.ltp) angelLegs.push({ instrument: position.instrument, strike: leg.strike, optionType: leg.optionType, expiry: position.angelExpiry || '' });
              }
            });
            setChainData(byLeg);
            if (result.underlyingValue) setLiveSpot(result.underlyingValue);
            const snap = { chainData: byLeg, chainSource: result.source, angelLtpByLeg: {}, savedAt: Date.now() };
            saveAnalysisSnapshot(position.positionId, snap);
            setSnapshotSavedAt(snap.savedAt);
            setLastUpdated(snap.savedAt);
          } else {
            // AngelOne couldn't provide data — try saved snapshot
            const snap = loadAnalysisSnapshot(position.positionId);
            if (snap) {
              setChainData(snap.chainData || {});
              setChainSource(snap.chainSource || null);
              setAngelLtpByLeg(snap.angelLtpByLeg || {});
              setLastUpdated(snap.savedAt || null);
              setSnapshotSavedAt(snap.savedAt);
            } else {
              setChainError('Market is closed. Opening this position during market hours will enable after-hours analysis using closing prices.');
            }
          }
        });
      };

      tryLiveEod();
      return () => { cancelled = true; };
    }

    const fetchChain = (isFirstLoad) => {
      if (isFirstLoad) setLoadingChain(true);
      const symbol = toNseSymbol(position.instrument);
      fetchOptionChain(symbol, position.expiry, RISK_FREE_RATE).then(result => {
        if (cancelled) return;
        if (isFirstLoad) setLoadingChain(false);
        if (!result.ok) {
          if (isFirstLoad) setChainError(result.error);
          else setPollFailing(true);
          return;
        }
        setPollFailing(false);
        setChainError(null);
        setChainSource(result.source);
        // NSE's response includes a reliable underlying value — prefer it
        // over the ticker quote when available, since it's from the same
        // snapshot as the option chain data itself (consistent pricing).
        if (result.underlyingValue) setLiveSpot(result.underlyingValue);

        const byLeg = {};
        position.legs.forEach(leg => {
          const row = result.rows.find(r => Math.abs(r.strike - leg.strike) < 0.01);
          const legData = row ? row[leg.optionType] : null;
          if (legData) {
            byLeg[leg.id] = { ltp: legData.ltp, iv: legData.iv, oi: legData.oi };
          }
        });
        setChainData(byLeg);
        setLastUpdated(Date.now());

        // AngelOne's Greeks/IV response never includes LTP — fetch real
        // current prices separately via the scrip-master-backed lookup
        // whenever AngelOne is the active source, so the legs table shows
        // genuine live prices instead of falling back to entry premiums.
        if (result.source === 'angelone') {
          const legsForLtp = position.legs.map(leg => ({
            instrument: position.instrument,
            strike: leg.strike,
            optionType: leg.optionType,
            expiry: position.expiry,
          }));
          fetchAngelOneLtp(legsForLtp).then(ltpResult => {
            if (cancelled || !ltpResult.ok) return;
            const byLegLtp = {};
            position.legs.forEach(leg => {
              const key = angelOneLtpKey({ instrument: position.instrument, strike: leg.strike, optionType: leg.optionType, expiry: position.expiry });
              if (ltpResult.quotesByKey[key] !== undefined) byLegLtp[leg.id] = ltpResult.quotesByKey[key];
            });
            setAngelLtpByLeg(byLegLtp);
            // Snapshot after the AngelOne lookup resolves too, so a
            // post-close session has real LTP and OI available, not just Greeks.
            saveAnalysisSnapshot(position.positionId, { chainData: byLeg, chainSource: result.source, angelLtpByLeg: byLegLtp, liveSpot: result.underlyingValue || liveSpotRef.current });
          });
        } else {
          setAngelLtpByLeg({});
          saveAnalysisSnapshot(position.positionId, { chainData: byLeg, chainSource: result.source, angelLtpByLeg: {}, liveSpot: result.underlyingValue || liveSpotRef.current });
        }
      });
    };

    fetchChain(true);
    const intervalId = setInterval(() => fetchChain(false), 7000);
    return () => { cancelled = true; clearInterval(intervalId); };
  }, [position?.positionId]); // eslint-disable-line

  if (!openPositions.length) {
    return (
      <div style={{ padding: 32 }}>
        <div className="page-title">Options analyzer</div>
        <div style={{ color: 'var(--text-muted)', marginTop: 12 }}>
          No open positions to analyze. Open a position to use the payoff and Greeks analyzer.
        </div>
      </div>
    );
  }
  if (!position) return null;

  // Build leg objects enriched with live chain data (iv/ltp/oi), falling back
  // to the entry premium's implied behavior if the chain hasn't loaded yet.
  const enrichedLegs = position.legs.map(leg => {
    const remainingQty = (leg.quantity || 1) - (leg.exits || []).reduce((s, e) => s + (e.quantity || 0), 0);
    const chain = chainData[leg.id];
    const angelData = angelLtpByLeg[leg.id]; // { ltp, oi } from AngelOne's FULL-mode quote lookup
    // A "live" LTP comes from either NSE's chain (which includes it
    // directly) or AngelOne's separate per-contract lookup (since
    // AngelOne's optionGreek endpoint never returns LTP or OI itself).
    // Only when neither source has resolved a real price does the entry
    // premium stand in, and it's clearly labeled as a placeholder when it does.
    const hasLiveLtp = (chainSource === 'nse' && chain?.ltp !== undefined && chain?.ltp !== null)
      || (chainSource === 'angelone' && angelData?.ltp !== undefined && angelData?.ltp !== null);
    const liveLtpValue = chainSource === 'nse' ? chain?.ltp : angelData?.ltp;
    const liveOiValue = chainSource === 'nse' ? chain?.oi : angelData?.oi;
    return {
      ...leg,
      quantity: remainingQty,
      iv: chain?.iv ?? 15,
      ltp: hasLiveLtp ? liveLtpValue : leg.premium,
      ltpIsLive: hasLiveLtp,
      oi: liveOiValue ?? 0,
    };
  }).filter(l => l.quantity > 0);

  const activeLegs = enrichedLegs.filter(l => checkedLegIds.has(l.id));

  const spotMin = Math.min(...enrichedLegs.map(l => l.strike)) * 0.92;
  const spotMax = Math.max(...enrichedLegs.map(l => l.strike)) * 1.08;
  const currentSpot = scenarioSpot ?? liveSpot ?? (spotMin + spotMax) / 2;

  const expiryMs = position.expiry ? new Date(position.expiry).getTime() : Date.now();
  const nowMs = nowTick;
  const marketTimestamps = useMemo(
    () => generateMarketTimestamps(nowMs, expiryMs),
    [expiryMs] // eslint-disable-line
  );
  const clampedIdx = Math.min(sliderIdx, marketTimestamps.length - 1);
  const targetMs = clampedIdx === 0 ? nowMs : marketTimestamps[clampedIdx];
  // Time remaining from the chosen target moment to expiry, in years —
  // hour-level precision rather than whole days, since theta decay is
  // continuous through the trading day, not a once-a-day step.
  const T = Math.max(expiryMs - targetMs, 0) / (1000 * 60 * 60 * 24 * 365);
  // True only when neither slider has been moved away from "right now" —
  // in that exact state, P&L should use real quoted LTPs rather than a
  // Black-Scholes re-derivation, so it matches the live P&L shown elsewhere.
  const isCurrentMoment = scenarioSpot === null && clampedIdx === 0;
  const allActiveLegsHaveLiveLtp = activeLegs.length > 0 && activeLegs.every(l => l.ltpIsLive);
  const useRealLtpForHeadline = isCurrentMoment && allActiveLegsHaveLiveLtp;
  const targetDaysToExpiry = Math.max(expiryMs - targetMs, 0) / (1000 * 60 * 60 * 24);

  const { maxProfit, maxLoss } = maxProfitLoss(activeLegs, spotMin, spotMax);
  const riskReward = (maxLoss < 0 && maxProfit > 0) ? `${(Math.abs(maxLoss) / maxProfit).toFixed(2)} : 1` : '—';
  const breakevens = findBreakevens(activeLegs, spotMin, spotMax);
  const net = netPremium(activeLegs);
  const curPnl = activeLegs.length ? payoffAt(activeLegs, currentSpot, T, RISK_FREE_RATE, useRealLtpForHeadline) : null;
  const intrinsic = activeLegs.length ? intrinsicAt(activeLegs, currentSpot) : null;
  const timeValue = curPnl !== null && intrinsic !== null ? curPnl - intrinsic : null;
  const greeks = activeLegs.length ? positionGreeks(activeLegs, currentSpot, T) : { delta: 0, gamma: 0, theta: 0, vega: 0 };
  const futPrice = impliedFuturesPrice(currentSpot, T);
  const { sd1, sd2 } = standardDeviation(activeLegs, currentSpot, T);

  const toggleLeg = (legId) => {
    setCheckedLegIds(prev => {
      const next = new Set(prev);
      if (next.has(legId)) next.delete(legId); else next.add(legId);
      return next;
    });
  };

  const selectAll = () => setCheckedLegIds(new Set(enrichedLegs.map(l => l.id)));

  // Build chart data points across the spot range for both curves
  const chartPoints = useMemo(() => {
    if (!activeLegs.length) return [];
    const step = Math.round((spotMax - spotMin) / 50 / 10) * 10 || 10;
    const pts = [];
    for (let s = spotMin; s <= spotMax; s += step) {
      pts.push({
        spot: s,
        onTarget: payoffAt(activeLegs, s, T),
        onExpiry: payoffAt(activeLegs, s, 0),
      });
    }
    return pts;
  }, [activeLegs, spotMin, spotMax, T]); // eslint-disable-line

  const maxAbsPnl = Math.max(1, ...chartPoints.map(p => Math.max(Math.abs(p.onTarget), Math.abs(p.onExpiry))));
  const maxOi = Math.max(1, ...enrichedLegs.map(l => l.oi));

  const pnlTablePrices = [
    Math.round(spotMin),
    Math.round(spotMin + (spotMax - spotMin) * 0.25),
    Math.round((spotMin + spotMax) / 2),
    Math.round(spotMin + (spotMax - spotMin) * 0.75),
    Math.round(spotMax),
  ];

  return (
    <div style={{ padding: 28 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14, flexWrap: 'wrap', gap: 8 }}>
        <div className="page-title" style={{ margin: 0 }}>Options analyzer</div>
        {usingSnapshot && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--text-muted)', display: 'inline-block' }} />
            market closed — analyzing last data from{' '}
            {snapshotSavedAt
              ? new Date(snapshotSavedAt).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
              : 'today'}
          </span>
        )}
        {!usingSnapshot && loadingChain && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>loading option chain…</span>}
        {!usingSnapshot && chainError && <span style={{ fontSize: 11, color: 'var(--loss)' }}>chain unavailable — using entry premiums</span>}
        {!usingSnapshot && !loadingChain && !chainError && pollFailing && (
          <span style={{ fontSize: 11, color: '#FFA53D', display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#FFA53D', display: 'inline-block' }} />
            live updates stalled — showing data from {secondsAgo}s ago
          </span>
        )}
        {!usingSnapshot && !loadingChain && !chainError && !pollFailing && lastUpdated && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 5, height: 5, borderRadius: '50%', background: 'var(--profit)', display: 'inline-block' }} />
            updated {secondsAgo}s ago
          </span>
        )}
      </div>

      <div style={{ marginBottom: 18 }}>
        <select
          value={position.positionId}
          onChange={e => setSelectedPositionId(e.target.value)}
          style={{ width: '100%', background: 'var(--bg-card2)', border: '1px solid var(--border)', borderRadius: 8, color: 'var(--text-primary)', fontSize: 13, padding: '9px 12px', outline: 'none', marginBottom: 10 }}
        >
          {openPositions.map(p => (
            <option key={p.positionId} value={p.positionId}>
              {p.instrument} {p.strategyName} · {p.expiry ? new Date(p.expiry).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : ''}
            </option>
          ))}
        </select>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: position.daysToExpiry !== null ? 8 : 0 }}>
          {position.legs.map(l => (
            <div key={l.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'var(--bg-card2)', borderRadius: 8, padding: '8px 12px' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{
                  fontSize: 10, fontWeight: 600, padding: '2px 6px', borderRadius: 4,
                  background: l.transactionType === 'SELL' ? 'var(--loss-dim)' : 'var(--profit-dim)',
                  color: l.transactionType === 'SELL' ? 'var(--loss)' : 'var(--profit)',
                }}>{l.transactionType}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{l.strike}{l.optionType}</span>
              </div>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{l.quantity}L × {l.lotSize}</span>
            </div>
          ))}
        </div>

        {position.daysToExpiry !== null && (
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', background: 'rgba(255,165,61,0.10)', borderRadius: 8, padding: '8px 12px' }}>
            <span style={{ fontSize: 11, color: '#FFA53D' }}>Expiry</span>
            <span style={{ fontSize: 13, fontWeight: 600, color: '#FFA53D' }}>
              {position.daysToExpiry}d{position.expiry ? ` · ${new Date(position.expiry).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}` : ''}
            </span>
          </div>
        )}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 8, marginBottom: 18 }}>
        <StatCard label="Max profit" value={fmtMoney(maxProfit)} color="var(--profit)" />
        <StatCard label="Max loss" value={fmtMoney(maxLoss)} color="var(--loss)" />
        <StatCard label="Risk:reward" value={riskReward} />
        <StatCard label="Breakeven" value={breakevens.length ? breakevens.map(b => b.toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2})).join(' / ') : '—'} />
        <StatCard label="Net premium" value={activeLegs.length ? fmtMoney(net) : '—'} color={net >= 0 ? 'var(--profit)' : 'var(--loss)'} />
        <StatCard label="Time value" value={fmtMoney(timeValue)} />
        <StatCard label="Margin used" value={position.margin ? `₹${position.margin.toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}` : '—'} />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '2.1fr 1fr', gap: 16, marginBottom: 16 }}>
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: '16px 18px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ display: 'flex', gap: 16 }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-secondary)' }}>
                <span style={{ width: 9, height: 2, background: 'var(--profit)', display: 'inline-block' }} />On target date
              </span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 12, color: 'var(--text-secondary)' }}>
                <span style={{ width: 9, height: 0, borderBottom: '1.5px dashed rgba(228,235,248,0.5)', display: 'inline-block' }} />On expiry
              </span>
            </div>
            <div style={{ display: 'flex', gap: 12, fontSize: 11, color: 'var(--text-muted)' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 8, height: 8, background: 'var(--loss)', opacity: 0.4, display: 'inline-block', borderRadius: 1 }} />Call OI</span>
              <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}><span style={{ width: 8, height: 8, background: 'var(--profit)', opacity: 0.4, display: 'inline-block', borderRadius: 1 }} />Put OI</span>
            </div>
          </div>

          {(() => {
            const W = 700, H = 280, padL = 46, padR = 16, padT = 16, padB = 30;
            const plotW = W - padL - padR;
            const plotH = H - padT - padB;
            const xScale = s => padL + ((s - spotMin) / (spotMax - spotMin)) * plotW;
            const yScale = v => padT + plotH / 2 - (v / maxAbsPnl) * (plotH / 2);
            const zeroY = yScale(0);

            const expiryPath = chartPoints.map((p, i) => `${i === 0 ? 'M' : 'L'}${xScale(p.spot)},${yScale(p.onExpiry)}`).join(' ');
            const targetPath = chartPoints.map((p, i) => `${i === 0 ? 'M' : 'L'}${xScale(p.spot)},${yScale(p.onTarget)}`).join(' ');
            const lossAreaPath = `${expiryPath} L${xScale(spotMax)},${zeroY} L${xScale(spotMin)},${zeroY} Z`;

            return (
              <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: 280 }}>
                {[0.25, 0.5, 0.75].map(frac => (
                  <line key={frac} x1={padL} y1={padT + plotH * frac} x2={W - padR} y2={padT + plotH * frac} stroke="rgba(255,255,255,0.04)" />
                ))}
                {enrichedLegs.filter(l => checkedLegIds.has(l.id)).map(leg => {
                  const x = xScale(leg.strike);
                  const barW = Math.max(plotW / 60, 4);
                  const barH = (leg.oi / maxOi) * (plotH * 0.42);
                  return (
                    <rect key={leg.id} x={x - barW / 2} y={zeroY - barH} width={barW} height={barH}
                      fill={leg.optionType === 'CE' ? 'var(--loss)' : 'var(--profit)'} opacity={0.32} />
                  );
                })}
                <line x1={padL} y1={zeroY} x2={W - padR} y2={zeroY} stroke="rgba(255,255,255,0.1)" />
                <path d={lossAreaPath} fill="var(--loss)" opacity={0.08} />
                {chartPoints.length > 1 && (
                  <>
                    <path d={expiryPath} fill="none" stroke="rgba(228,235,248,0.4)" strokeWidth="1.5" strokeDasharray="4,4" />
                    <path d={targetPath} fill="none" stroke="var(--profit)" strokeWidth="2.5" />
                  </>
                )}
                {(() => {
                  const xPos = xScale(currentSpot);
                  return (
                    <>
                      <line x1={xPos} y1={padT} x2={xPos} y2={H - padB} stroke="var(--accent)" strokeWidth="1" strokeDasharray="3,3" />
                      <rect x={xPos - 58} y={2} width={116} height={18} rx={4} fill="var(--bg-card2)" stroke="var(--border)" />
                      <text x={xPos} y={14} fontSize="10" fill="var(--text-primary)" textAnchor="middle" fontFamily="inherit">
                        Spot: {currentSpot.toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}
                      </text>
                    </>
                  );
                })()}
                {[0, 0.25, 0.5, 0.75, 1].map(frac => {
                  const val = spotMin + (spotMax - spotMin) * frac;
                  return (
                    <text key={frac} x={xScale(val)} y={H - 8} fontSize="10" fill="var(--text-muted)" textAnchor="middle">
                      {val.toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2})}
                    </text>
                  );
                })}
              </svg>
            );
          })()}

          <div style={{ textAlign: 'center', marginTop: 10 }}>
            <span style={{
              fontSize: 13, fontFamily: 'var(--font-mono)', padding: '5px 12px', borderRadius: 6,
              background: curPnl >= 0 ? 'var(--profit-dim)' : 'var(--loss-dim)',
              color: curPnl >= 0 ? 'var(--profit)' : 'var(--loss)',
            }}>
              {activeLegs.length ? `${curPnl >= 0 ? 'Projected profit: ' : 'Projected loss: '}${fmtMoney(curPnl)}` : 'No legs selected'}
            </span>
          </div>

          <div style={{ marginTop: 18, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  Target spot price
                  {scenarioSpot !== null && (
                    <button onClick={() => setScenarioSpot(null)} style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: 11, cursor: 'pointer', padding: 0 }}>reset</button>
                  )}
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <button onClick={() => setScenarioSpot(Math.max(spotMin, currentSpot - 10))}
                    style={{ background: 'var(--bg-card2)', border: '1px solid var(--border)', borderRadius: 5, color: 'var(--text-primary)', width: 24, height: 24, cursor: 'pointer', fontSize: 14, lineHeight: 1 }}>−</button>
                  <input
                    type="number"
                    value={Math.round(currentSpot)}
                    onChange={e => {
                      const v = parseFloat(e.target.value);
                      if (!isNaN(v)) setScenarioSpot(v);
                    }}
                    style={{
                      width: 90, textAlign: 'right', fontFamily: 'var(--font-mono)',
                      fontSize: 15, fontWeight: 600, color: 'var(--text-primary)',
                      background: 'var(--bg-card2)', border: '1px solid var(--border)', borderRadius: 5,
                      padding: '4px 8px',
                    }}
                  />
                  <button onClick={() => setScenarioSpot(Math.min(spotMax, currentSpot + 10))}
                    style={{ background: 'var(--bg-card2)', border: '1px solid var(--border)', borderRadius: 5, color: 'var(--text-primary)', width: 24, height: 24, cursor: 'pointer', fontSize: 14, lineHeight: 1 }}>+</button>
                </div>
              </div>
              <input type="range" min={spotMin} max={spotMax} step={10} value={currentSpot}
                onChange={e => setScenarioSpot(parseFloat(e.target.value))}
                style={{ width: '100%', accentColor: 'var(--accent)' }} />
            </div>
            <div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  Target date
                  {clampedIdx > 0 && (
                    <button onClick={() => setSliderIdx(0)} style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: 11, cursor: 'pointer', padding: 0 }}>reset</button>
                  )}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <button
                  onClick={() => setSliderIdx(i => Math.max(0, i - 1))}
                  style={{ background: 'var(--bg-card2)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', width: 28, height: 28, cursor: 'pointer', fontSize: 14 }}
                >‹</button>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 13, fontWeight: 600 }}>
                    {new Date(targetMs).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short' })}
                    {' '}
                    {new Date(targetMs).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                    {clampedIdx === 0 ? 'Now' : targetDaysToExpiry < 1
                      ? `${Math.round(targetDaysToExpiry * 24)} hours to expiry`
                      : `${targetDaysToExpiry.toFixed(1)} days to expiry`}
                  </div>
                </div>
                <button
                  onClick={() => setSliderIdx(i => Math.min(marketTimestamps.length - 1, i + 1))}
                  style={{ background: 'var(--bg-card2)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', width: 28, height: 28, cursor: 'pointer', fontSize: 14 }}
                >›</button>
              </div>
              <input type="range" min={0} max={marketTimestamps.length - 1} step={1} value={clampedIdx}
                onChange={e => setSliderIdx(parseInt(e.target.value, 10))}
                style={{ width: '100%', accentColor: 'var(--accent)' }} />
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
                <span>Now · {new Date(nowMs).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}</span>
                <span>Expiry · {new Date(expiryMs).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}</span>
              </div>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px' }}>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 10 }}>Greeks (selected legs)</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 9 }}>
              {[
                ['Delta', greeks.delta.toFixed(1)],
                ['Gamma', greeks.gamma.toFixed(3)],
                ['Theta / day', fmtMoney(greeks.theta)],
                ['Vega', fmtMoney(greeks.vega)],
              ].map(([label, val]) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ fontSize: 13, color: 'var(--text-secondary)' }}>{label}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 14, fontWeight: 600 }}>{val}</span>
                </div>
              ))}
            </div>
          </div>

          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px' }}>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 10 }}>Standard deviation</div>
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', fontFamily: 'var(--font-mono)' }}>
              <tbody>
                <tr><td style={{ padding: '3px 0', fontFamily: 'Inter, sans-serif' }}>1 SD</td><td style={{ textAlign: 'right' }}>{Math.round(sd1).toLocaleString('en-IN')}</td><td style={{ textAlign: 'right', fontSize: 11, color: 'var(--text-secondary)' }}>{Math.round(currentSpot - sd1).toLocaleString('en-IN')} - {Math.round(currentSpot + sd1).toLocaleString('en-IN')}</td></tr>
                <tr><td style={{ padding: '3px 0', fontFamily: 'Inter, sans-serif' }}>2 SD</td><td style={{ textAlign: 'right' }}>{Math.round(sd2).toLocaleString('en-IN')}</td><td style={{ textAlign: 'right', fontSize: 11, color: 'var(--text-secondary)' }}>{Math.round(currentSpot - sd2).toLocaleString('en-IN')} - {Math.round(currentSpot + sd2).toLocaleString('en-IN')}</td></tr>
              </tbody>
            </table>
          </div>

          <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px' }}>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 }}>Target day futures</div>
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 15, fontWeight: 600 }}>{futPrice.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>Implied by carry to target date</div>
          </div>
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr', gap: 16 }}>
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
            <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ width: 6, height: 6, borderRadius: '50%', background: chainSource === 'nse' ? 'var(--profit)' : chainSource === 'angelone' ? '#FFA53D' : 'var(--text-muted)', display: 'inline-block' }} />
              <span>{checkedLegIds.size} of {enrichedLegs.length} legs selected{chainSource ? ` · ${usingSnapshot ? `${chainSource === 'nse' ? 'NSE' : 'AngelOne'} (last close)` : (chainSource === 'nse' ? 'live from NSE' : 'live from AngelOne')}` : ''}</span>
            </div>
            <button onClick={selectAll} style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: 11, cursor: 'pointer' }}>select all</button>
          </div>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', fontFamily: 'var(--font-mono)' }}>
            <thead>
              <tr style={{ color: 'var(--text-muted)' }}>
                <th style={{ width: 26 }}></th>
                <th style={{ textAlign: 'left', fontFamily: 'Inter, sans-serif', fontWeight: 500, padding: '4px 0' }}>Leg</th>
                <th style={{ textAlign: 'right', fontWeight: 500, padding: '4px 0' }}>Avg</th>
                <th style={{ textAlign: 'right', fontWeight: 500, padding: '4px 0' }}>LTP</th>
                <th style={{ textAlign: 'right', fontWeight: 500, padding: '4px 0' }}>IV</th>
                <th style={{ textAlign: 'right', fontWeight: 500, padding: '4px 0' }}>OI</th>
                <th style={{ textAlign: 'right', fontWeight: 500, padding: '4px 0' }}>Delta</th>
                <th style={{ textAlign: 'right', fontWeight: 500, padding: '4px 0' }}>Theta</th>
              </tr>
            </thead>
            <tbody>
              {enrichedLegs.map(leg => {
                const isChecked = checkedLegIds.has(leg.id);
                const sign = leg.transactionType === 'SELL' ? -1 : 1;
                const g = positionGreeks([leg], currentSpot, T);
                return (
                  <tr key={leg.id} style={{ borderTop: '1px solid var(--border)', opacity: isChecked ? 1 : 0.35 }}>
                    <td style={{ padding: '6px 0' }}>
                      <input type="checkbox" checked={isChecked} onChange={() => toggleLeg(leg.id)} style={{ accentColor: 'var(--accent)', cursor: 'pointer' }} />
                    </td>
                    <td style={{ padding: '6px 0', textAlign: 'left', fontFamily: 'Inter, sans-serif' }}>
                      <span style={{
                        display: 'inline-block', width: 16, height: 16, borderRadius: 3, textAlign: 'center', lineHeight: '16px',
                        fontSize: 10, fontWeight: 700, marginRight: 6,
                        background: leg.transactionType === 'SELL' ? 'var(--loss-dim)' : 'var(--profit-dim)',
                        color: leg.transactionType === 'SELL' ? 'var(--loss)' : 'var(--profit)',
                      }}>{leg.transactionType === 'SELL' ? 'S' : 'B'}</span>
                      {leg.quantity} x {position.expiry ? new Date(position.expiry).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' }) : ''} {leg.strike} {leg.optionType}
                    </td>
                    <td style={{ padding: '6px 0', textAlign: 'right', color: 'var(--text-secondary)' }}>{fmt(leg.premium)}</td>
                    <td style={{ padding: '6px 0', textAlign: 'right', color: leg.ltpIsLive ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                      {fmt(leg.ltp)}{!leg.ltpIsLive && <span style={{ fontSize: 9 }}> (entry)</span>}
                    </td>
                    <td style={{ padding: '6px 0', textAlign: 'right' }}>{fmt(leg.iv)}%</td>
                    <td style={{ padding: '6px 0', textAlign: 'right' }}>{fmt((leg.oi || 0) / 100000)}L</td>
                    <td style={{ padding: '6px 0', textAlign: 'right' }}>{fmt(sign * g.delta, 2)}</td>
                    <td style={{ padding: '6px 0', textAlign: 'right' }}>{fmt(sign * g.theta)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px' }}>
          <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 10 }}>P&L at key prices</div>
          <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', fontFamily: 'var(--font-mono)' }}>
            <thead>
              <tr style={{ color: 'var(--text-muted)' }}>
                <th style={{ textAlign: 'left', fontFamily: 'Inter, sans-serif', fontWeight: 500, padding: '3px 0' }}>Spot</th>
                <th style={{ textAlign: 'right', fontWeight: 500, padding: '3px 0' }}>On expiry</th>
                <th style={{ textAlign: 'right', fontWeight: 500, padding: '3px 0' }}>On target date</th>
              </tr>
            </thead>
            <tbody>
              {pnlTablePrices.map(price => {
                const expiryPnl = activeLegs.length ? payoffAt(activeLegs, price, 0) : 0;
                const targetPnl = activeLegs.length ? payoffAt(activeLegs, price, T) : 0;
                return (
                  <tr key={price} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '5px 0', textAlign: 'left', fontFamily: 'Inter, sans-serif' }}>{price.toLocaleString('en-IN')}</td>
                    <td style={{ padding: '5px 0', textAlign: 'right', color: expiryPnl >= 0 ? 'var(--profit)' : 'var(--loss)' }}>{fmtMoney(expiryPnl)}</td>
                    <td style={{ padding: '5px 0', textAlign: 'right', color: targetPnl >= 0 ? 'var(--profit)' : 'var(--loss)' }}>{fmtMoney(targetPnl)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div style={{ marginTop: 16, fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.5 }}>
        Uncheck a leg to exclude it from every panel above. IV/OI sourced from the live option chain (NSE primary, AngelOne fallback). Greeks calculated with Black-Scholes using that market-quoted IV per strike.
      </div>
    </div>
  );
}
