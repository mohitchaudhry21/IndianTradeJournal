import React, { useState, useEffect, useMemo } from 'react';
import { fetchOptionChain, fetchExpiryList, fetchAngelOneLtp, angelOneLtpKey } from '../utils/optionChain';
import { fetchTickerQuotes } from '../utils/tickerQuotes';
import { payoffAt, netPremium, findBreakevens, positionGreeks, maxProfitLoss, impliedFuturesPrice, standardDeviation, calibrateLegsIV } from '../utils/optionsAnalysis';
import { KNOWN_SYMBOLS } from '../utils/tickerSymbols';
import { getLotSize } from '../utils/lotSizes';

const RISK_FREE_RATE = 0.065;

// Defensive formatting — broker APIs occasionally return numeric fields as
// strings or omit them entirely, and a bare .toFixed() call on anything
// non-numeric crashes the whole page rather than degrading gracefully.
function fmt(value, decimals = 2) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) ? n.toFixed(decimals) : '—';
}

import { generateMarketTimestamps, isMonthlyExpiry, isMarketOpen } from '../utils/marketHours';

// OI change is stored as an absolute delta (changeInOi), not a percentage —
// derive the percentage from the implied previous OI. Returns null rather
// than 0 when there's no real OI data (e.g. AngelOne's chain, which never
// reports OI), so the UI can show a dash instead of a misleading "+0%".
function oiChangePct(side) {
  if (!side) return null;
  const prevOi = side.oi - side.changeInOi;
  if (!prevOi) return null;
  return (side.changeInOi / prevOi) * 100;
}

function OiBar({ value, max, color }) {
  const pct = max > 0 ? Math.min(100, (value / max) * 100) : 0;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <div style={{ width: 32, height: 6, background: 'var(--bg-card2)', borderRadius: 3, overflow: 'hidden' }}>
        <div style={{ width: `${pct}%`, height: 6, background: color, borderRadius: 3 }} />
      </div>
      <span style={{ fontSize: 11, color: 'var(--text-muted)', minWidth: 28 }}>{value ? fmt(value / 100000, 1) + 'L' : '—'}</span>
    </div>
  );
}

function formatAngelExpiry(angelExpiry) {
  // "26JUN2026" -> "26 Jun"
  if (!angelExpiry || angelExpiry.length < 7) return angelExpiry;
  const day = angelExpiry.slice(0, 2);
  const monthAbbr = angelExpiry.slice(2, 5);
  const monthName = monthAbbr.charAt(0) + monthAbbr.slice(1).toLowerCase();
  return `${day} ${monthName}`;
}

let legIdCounter = 0;
function nextLegId() {
  legIdCounter += 1;
  return `leg_${legIdCounter}`;
}

export default function StrategyBuilder() {
  const [instrument, setInstrument] = useState(() => {
    try { return sessionStorage.getItem('sb_instrument') || 'NIFTY'; } catch { return 'NIFTY'; }
  });
  const [expiries, setExpiries] = useState([]);
  const [selectedExpiry, setSelectedExpiry] = useState(() => {
    try { return sessionStorage.getItem('sb_expiry') || null; } catch { return null; }
  });
  const [chainRows, setChainRows] = useState([]);
  const [chainSource, setChainSource] = useState(null);
  const [loadingChain, setLoadingChain] = useState(false);
  const [chainError, setChainError] = useState(null);
  const [spot, setSpot] = useState(null);

  const [legs, setLegs] = useState(() => {
    // Restore legs from sessionStorage on reload
    try { const saved = sessionStorage.getItem('sb_legs'); return saved ? JSON.parse(saved) : []; } catch { return []; }
  });
  const [scenarioSpot, setScenarioSpot] = useState(null);
  const [pickerView, setPickerView] = useState('CHAIN'); // 'CHAIN' | 'GREEKS' | 'FUTURES'
  const [hoveredStrike, setHoveredStrike] = useState(null);

  // Drafts — persisted in localStorage
  const [drafts, setDrafts] = useState(() => {
    try { return JSON.parse(localStorage.getItem('sb_drafts') || '[]'); } catch { return []; }
  });
  const [showDrafts, setShowDrafts] = useState(false);
  const atmRowRef = React.useRef(null);
  const tableBodyRef = React.useRef(null);
  const hasScrolledToAtm = React.useRef(false); // only auto-scroll ATM on first load
  const chartSvgRef = React.useRef(null);
  const [chartHoverSpot, setChartHoverSpot] = React.useState(null); // spot under mouse in payoff chart
  const [targetTimeMs, setTargetTimeMs] = React.useState(null); // null = right now

  // Tick every second so "right now" stays current (matches OptionsAnalyzer)
  const [nowTick, setNowTick] = React.useState(Date.now());
  React.useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // Pre-compute the array of valid market timestamps (Mon–Fri 9:15–15:30 IST)
  // Derive expiry epoch directly from selectedExpiry string to avoid TDZ
  // (expiryDate useMemo is defined later in the component).
  const nowMs = nowTick;
  const expiryMsForSlider = React.useMemo(() => {
    if (!selectedExpiry) return nowMs + 7 * 24 * 60 * 60 * 1000;
    const day = parseInt(selectedExpiry.slice(0, 2), 10);
    const monthAbbr = selectedExpiry.slice(2, 5).toUpperCase();
    const year = parseInt(selectedExpiry.slice(5), 10);
    const months = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
    return new Date(year, months[monthAbbr] ?? 0, day, 15, 30).getTime();
  }, [selectedExpiry]); // eslint-disable-line
  const marketTimestamps = React.useMemo(
    () => generateMarketTimestamps(nowMs, expiryMsForSlider),
    [expiryMsForSlider] // eslint-disable-line
  );
  // sliderIdx: index into marketTimestamps. 0 = now, last = expiry.
  const [sliderIdx, setSliderIdx] = React.useState(0);
  // Keep sliderIdx in bounds when marketTimestamps changes length
  const clampedIdx = Math.min(sliderIdx, marketTimestamps.length - 1);

  // Fetch available expiries whenever the instrument changes
  useEffect(() => {
    let cancelled = false;
    fetchExpiryList(instrument).then(result => {
      if (cancelled) return;
      if (result.ok && result.expiries.length) {
        setExpiries(result.expiries);
        setSelectedExpiry(result.expiries[0]);
      } else {
        setExpiries([]);
        setSelectedExpiry(null);
      }
    });
    return () => { cancelled = true; };
  }, [instrument]);

  // Clear legs when switching instrument — a strategy mixing NIFTY and
  // BANKNIFTY legs isn't a coherent single payoff, so starting fresh
  // avoids silently producing a nonsensical combined chart.
  useEffect(() => {
    setLegs([]);
    setScenarioSpot(null);
  }, [instrument]);

  // Live spot price, independent of chain source
  useEffect(() => {
    let cancelled = false;
    const fetchSpot = () => {
      fetchTickerQuotes([instrument]).then(result => {
        if (cancelled) return;
        const quote = result.quotes?.find(q => q.name === instrument);
        if (quote?.ltp) setSpot(quote.ltp);
      });
    };
    fetchSpot();
    const intervalId = setInterval(fetchSpot, 7000);
    return () => { cancelled = true; clearInterval(intervalId); };
  }, [instrument]);

  // Fetch the full option chain for the selected instrument + expiry,
  // polled to keep the strike-picker table's LTP/IV/OI columns live.
  useEffect(() => {
    if (!selectedExpiry) return;
    let cancelled = false;

    // The chain fetch utility expects an ISO-ish date for internal format
    // conversion; reconstruct a real Date from the AngelOne string so it
    // round-trips correctly through toNseExpiryFormat/toAngelOneExpiryFormat.
    // Build a UTC ISO string from the AngelOne expiry string (e.g. "23JUN2026")
    // using Date.UTC so the date doesn't roll back one day when IST (+5:30)
    // is converted to UTC (e.g. local midnight 23 Jun → "2026-06-22T18:30:00Z").
    const isoFromAngel = (() => {
      const day = parseInt(selectedExpiry.slice(0, 2), 10);
      const monthAbbr = selectedExpiry.slice(2, 5).toUpperCase();
      const year = parseInt(selectedExpiry.slice(5), 10);
      const months = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
      return new Date(Date.UTC(year, months[monthAbbr] ?? 0, day)).toISOString();
    })();

    const fetchChain = (isFirstLoad) => {
      if (isFirstLoad) setLoadingChain(true);
      fetchOptionChain(instrument, isoFromAngel, RISK_FREE_RATE).then(result => {
        if (cancelled) return;
        if (isFirstLoad) setLoadingChain(false);
        if (!result.ok) {
          if (isFirstLoad) setChainError(result.error);
          return;
        }
        setChainError(null);
        setChainSource(result.source);
        // Preserve LTP/OI from previous rows — the optionGreek API never
        // returns LTP, so naively overwriting with result.rows would reset
        // every LTP to 0 on each 10s poll, causing a visible flash before
        // the backfill patches them back in.
        setChainRows(prevRows => {
          const prevByStrike = {};
          prevRows.forEach(r => { prevByStrike[r.strike] = r; });
          return result.rows.map(row => {
            const prev = prevByStrike[row.strike];
            if (!prev) return row;
            return {
              ...row,
              CE: row.CE ? { ...row.CE, ltp: prev.CE?.ltp ?? row.CE.ltp, oi: prev.CE?.oi ?? row.CE.oi } : row.CE,
              PE: row.PE ? { ...row.PE, ltp: prev.PE?.ltp ?? row.PE.ltp, oi: prev.PE?.oi ?? row.PE.oi } : row.PE,
            };
          });
        });
        if (result.underlyingValue) setSpot(result.underlyingValue);

        // AngelOne's optionGreek API (the fallback used whenever NSE's
        // chain is blocked) only ever returns Greeks/IV — never LTP or OI,
        // confirmed against its own documented response fields. Without
        // this follow-up call every strike would show a flat 0 LTP and a
        // blank OI, indistinguishable from the chain having no data at all
        // even though it loaded successfully. Mirrors the same real-price
        // backfill the Options Analyzer already does for saved legs.
        if (result.source === 'angelone' && result.rows.length) {
          // Limit LTP backfill to ATM ±25 strikes — sending all 300+ legs in one
          // request causes Flask's JSON parser to silently return None (400 "No legs
          // provided"), and deep OTM strikes aren't practically useful for strategy
          // building anyway. Find the ATM strike first, then filter around it.
          const spotVal = result.underlyingValue || spot;
          const sortedStrikes = result.rows.map(r => r.strike).sort((a, b) => a - b);
          const atmStrike = spotVal
            ? sortedStrikes.reduce((best, s) => Math.abs(s - spotVal) < Math.abs(best - spotVal) ? s : best, sortedStrikes[0])
            : sortedStrikes[Math.floor(sortedStrikes.length / 2)];
          const atmIdx = sortedStrikes.indexOf(atmStrike);
          const nearAtmStrikes = new Set(sortedStrikes.slice(Math.max(0, atmIdx - 25), atmIdx + 26));

          const legsToPrice = [];
          result.rows.forEach(row => {
            if (!nearAtmStrikes.has(row.strike)) return;
            ['CE', 'PE'].forEach(type => {
              if (row[type]) legsToPrice.push({ instrument, strike: row.strike, optionType: type, expiry: isoFromAngel });
            });
          });
          console.log(`[LTP backfill] ${legsToPrice.length} legs near ATM ${atmStrike} (spot ${spotVal})`);
          if (!legsToPrice.length) return;
          fetchAngelOneLtp(legsToPrice).then(ltpResult => {
            if (cancelled || !ltpResult.ok) {
              console.warn('[LTP backfill] failed:', ltpResult.error);
              return;
            }
            setChainRows(prevRows => prevRows.map(row => {
              const next = { ...row };
              ['CE', 'PE'].forEach(type => {
                if (!next[type]) return;
                const key = angelOneLtpKey({ instrument, strike: row.strike, optionType: type, expiry: isoFromAngel });
                const quote = ltpResult.quotesByKey[key];
                if (quote) next[type] = { ...next[type], ltp: quote.ltp, oi: quote.oi };
              });
              return next;
            }));
          });
        }
      });
    };

    fetchChain(true);
    // Only poll during market hours — outside hours, one EOD fetch is enough
    const intervalId = isMarketOpen() ? setInterval(() => fetchChain(false), 10000) : null;
    return () => { cancelled = true; if (intervalId) clearInterval(intervalId); };
  }, [instrument, selectedExpiry]);

  // Scroll ATM row into view only on the first chain load for this instrument/expiry.
  // Subsequent 10s poll updates must NOT re-trigger this — that's what causes the
  // page to jump every 10 seconds.
  useEffect(() => {
    if (hasScrolledToAtm.current || !chainRows.length || !atmRowRef.current) return;
    hasScrolledToAtm.current = true;
    const timer = setTimeout(() => {
      if (atmRowRef.current) {
        atmRowRef.current.scrollIntoView({ block: 'center', behavior: 'smooth' });
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [chainRows.length]); // intentionally NOT watching spot — spot changes on every poll

  // Reset the scroll guard when the user changes instrument or expiry
  useEffect(() => {
    hasScrolledToAtm.current = false;
  }, [instrument, selectedExpiry]);

  // Persist current strategy state to sessionStorage so navigating away and back restores it
  useEffect(() => {
    try {
      sessionStorage.setItem('sb_legs', JSON.stringify(legs));
      if (instrument) sessionStorage.setItem('sb_instrument', instrument);
      if (selectedExpiry) sessionStorage.setItem('sb_expiry', selectedExpiry);
    } catch {}
  }, [legs, instrument, selectedExpiry]);

  // Persist drafts to localStorage whenever they change
  useEffect(() => {
    try { localStorage.setItem('sb_drafts', JSON.stringify(drafts)); } catch {}
  }, [drafts]);

  const lotSize = getLotSize(instrument);

  // Add a leg when a strike's LTP cell is clicked. If a leg for this exact
  // strike+type already exists, increment its quantity instead of adding a
  // duplicate row — mirrors how Sensibull's picker behaves.
  function addLeg(strike, optionType, transactionType) {
    const row = chainRows.find(r => r.strike === strike);
    const sideData = row ? row[optionType] : null;
    setLegs(prev => {
      const existingIdx = prev.findIndex(l => l.strike === strike && l.optionType === optionType && l.transactionType === transactionType);
      if (existingIdx >= 0) {
        const next = [...prev];
        next[existingIdx] = { ...next[existingIdx], quantity: next[existingIdx].quantity + 1 };
        return next;
      }
      return [...prev, {
        id: nextLegId(),
        strike,
        optionType,
        transactionType,
        quantity: 1,
        lotSize,
        iv: sideData?.iv || 15,
        premium: sideData?.ltp || 0,
        ltp: sideData?.ltp || 0,
        ltpIsLive: chainSource === 'nse',
      }];
    });
  }

  function removeLeg(id) {
    setLegs(prev => prev.filter(l => l.id !== id));
  }

  function updateLegQty(id, qty) {
    setLegs(prev => prev.map(l => l.id === id ? { ...l, quantity: Math.max(1, qty) } : l));
  }

  function clearAllLegs() {
    setLegs([]);
  }

  function saveDraft() {
    if (!legs.length) return;
    const name = `${instrument} ${selectedExpiry ? formatAngelExpiry(selectedExpiry) : ''} · ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`;
    const draft = { id: Date.now(), name, instrument, selectedExpiry, legs };
    setDrafts(prev => [draft, ...prev.slice(0, 19)]); // keep max 20 drafts
  }

  function loadDraft(draft) {
    setLegs(draft.legs);
    if (draft.instrument) setInstrument(draft.instrument);
    if (draft.selectedExpiry) setSelectedExpiry(draft.selectedExpiry);
    setShowDrafts(false);
  }

  function deleteDraft(id) {
    setDrafts(prev => prev.filter(d => d.id !== id));
  }

  function addFuturesLeg(expiry, forwardPrice, transactionType) {
    setLegs(prev => {
      const existingIdx = prev.findIndex(l => l.optionType === 'FUT' && l.expiry === expiry && l.transactionType === transactionType);
      if (existingIdx >= 0) {
        const next = [...prev];
        next[existingIdx] = { ...next[existingIdx], quantity: next[existingIdx].quantity + 1 };
        return next;
      }
      return [...prev, {
        id: nextLegId(),
        strike: forwardPrice,
        optionType: 'FUT',
        expiry,
        transactionType,
        quantity: 1,
        lotSize,
        iv: 0,
        premium: forwardPrice,
        ltp: forwardPrice,
        ltpIsLive: false,
      }];
    });
  }

  // Keep each leg's iv/ltp synced to the live chain as it refreshes, so a
  // leg added a while ago doesn't sit on a stale snapshot indefinitely.
  useEffect(() => {
    if (!chainRows.length || !legs.length) return;
    setLegs(prev => prev.map(leg => {
      const row = chainRows.find(r => Math.abs(r.strike - leg.strike) < 0.01);
      const sideData = row ? row[leg.optionType] : null;
      if (!sideData) return leg;
      return { ...leg, iv: sideData.iv || leg.iv, ltp: sideData.ltp || leg.ltp, ltpIsLive: chainSource === 'nse' };
    }));
  }, [chainRows, chainSource]); // eslint-disable-line

  const currentSpot = scenarioSpot ?? spot ?? (chainRows[Math.floor(chainRows.length / 2)]?.strike || 0);
  const spotMin = chainRows.length ? Math.min(...chainRows.map(r => r.strike)) : (currentSpot * 0.92);
  const spotMax = chainRows.length ? Math.max(...chainRows.map(r => r.strike)) : (currentSpot * 1.08);

  const expiryDate = useMemo(() => {
    if (!selectedExpiry) return null;
    const day = parseInt(selectedExpiry.slice(0, 2), 10);
    const monthAbbr = selectedExpiry.slice(2, 5).toUpperCase();
    const year = parseInt(selectedExpiry.slice(5), 10);
    const months = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
    const d = new Date(year, months[monthAbbr] ?? 0, day, 15, 30); // expiry at market close
    return d;
  }, [selectedExpiry]);

  const T = expiryDate ? Math.max(expiryDate.getTime() - Date.now(), 0) / (1000 * 60 * 60 * 24 * 365) : 0;
  const daysToExpiry = expiryDate ? Math.max(expiryDate.getTime() - Date.now(), 0) / (1000 * 60 * 60 * 24) : 0;

  // Mirror OptionsAnalyzer's time slider: targetTimeMs=null means right now
  const expiryMs = expiryDate ? expiryDate.getTime() : nowMs;
  const targetMs = clampedIdx === 0 ? nowMs : marketTimestamps[clampedIdx];
  const T_chart = Math.max(expiryMs - targetMs, 0) / (1000 * 60 * 60 * 24 * 365);
  const targetDaysToExpiry = Math.max(expiryMs - targetMs, 0) / (1000 * 60 * 60 * 24);
  const isCurrentMoment = clampedIdx === 0;

  // Back-solve each leg's IV from its real market LTP so that Black-Scholes
  // is calibrated to actual quoted prices. Without this, BS with a 12% chain
  // IV gives ~₹2 for a 600-OTM call that the market is quoting at ₹31 —
  // producing a massive phantom P&L loss on the chart. Recalibration ensures
  // BS(current_spot, strike, T, r, calibratedIV) = entry_premium exactly.
  const calibratedLegs = useMemo(() => {
    if (!legs.length || T <= 0) return legs;
    return calibrateLegsIV(legs, currentSpot, T, RISK_FREE_RATE);
  }, [legs, currentSpot, T]); // eslint-disable-line

  const curPnl = calibratedLegs.length ? payoffAt(calibratedLegs, currentSpot, T_chart, RISK_FREE_RATE, isCurrentMoment) : null;
  const { maxProfit, maxLoss } = calibratedLegs.length ? maxProfitLoss(calibratedLegs, spotMin, spotMax) : { maxProfit: null, maxLoss: null };
  const breakevens = calibratedLegs.length ? findBreakevens(calibratedLegs, spotMin, spotMax) : [];
  const greeks = calibratedLegs.length ? positionGreeks(calibratedLegs, currentSpot, T, RISK_FREE_RATE) : { delta: 0, gamma: 0, theta: 0, vega: 0 };
  const netPrem = calibratedLegs.length ? netPremium(calibratedLegs) : 0;
  const sd = calibratedLegs.length && currentSpot ? standardDeviation(calibratedLegs, currentSpot, T) : { sd1: 0, sd2: 0 };
  const futuresPrice = currentSpot ? impliedFuturesPrice(currentSpot, T) : 0;
  const riskReward = (maxLoss !== null && maxLoss < 0 && maxProfit !== null && maxProfit > 0) ? `${(maxProfit / Math.abs(maxLoss)).toFixed(2)} : 1` : '—';

  // Probability of Profit: fraction of spot range where expiry payoff > 0
  const pop = useMemo(() => {
    if (!calibratedLegs.length || !chainRows.length) return null;
    const step = Math.round((spotMax - spotMin) / 200 / 10) * 10 || 5;
    let wins = 0, total = 0;
    for (let s = spotMin; s <= spotMax; s += step) {
      if (payoffAt(calibratedLegs, s, 0) > 0) wins++;
      total++;
    }
    return total > 0 ? Math.round((wins / total) * 100) : null;
  }, [calibratedLegs, spotMin, spotMax]); // eslint-disable-line

  // Intrinsic value = payoff at expiry at current spot
  const intrinsicValue = calibratedLegs.length && currentSpot ? payoffAt(calibratedLegs, currentSpot, 0) : 0;
  // Time value = difference between current (with time) vs expiry payoff
  const timeValue = calibratedLegs.length && currentSpot ? (payoffAt(calibratedLegs, currentSpot, T, RISK_FREE_RATE, true) - intrinsicValue) : 0;

  const chartPoints = useMemo(() => {
    if (!calibratedLegs.length || !chainRows.length) return [];
    const step = Math.round((spotMax - spotMin) / 50 / 10) * 10 || 10;
    const pts = [];
    for (let s = spotMin; s <= spotMax; s += step) {
      pts.push({ spot: s, onExpiry: payoffAt(calibratedLegs, s, 0), onTarget: payoffAt(calibratedLegs, s, T_chart) });
    }
    return pts;
  }, [calibratedLegs, spotMin, spotMax, T_chart]); // eslint-disable-line

  const maxAbsPnl = chartPoints.length ? Math.max(...chartPoints.map(p => Math.max(Math.abs(p.onExpiry), Math.abs(p.onTarget))), 1) : 1;
  const maxOi = chainRows.length ? Math.max(...chainRows.map(r => Math.max(r.CE?.oi || 0, r.PE?.oi || 0)), 1) : 1;

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
        <div className="page-title">Strategy builder</div>
        {chainSource && (
          <span style={{ fontSize: 11, color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: 5 }}>
            <span style={{ width: 6, height: 6, borderRadius: '50%', background: isMarketOpen() ? 'var(--profit)' : '#FFA53D', display: 'inline-block' }} />
            {isMarketOpen() ? 'live' : 'EOD'} from {chainSource === 'nse' ? 'NSE' : 'AngelOne'}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 14, background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: '10px 14px', marginBottom: 16, flexWrap: 'wrap' }}>
        <select value={instrument} onChange={e => setInstrument(e.target.value)}
          style={{ background: 'var(--bg-card2)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', padding: '6px 10px', fontSize: 13 }}>
          {KNOWN_SYMBOLS.map(s => <option key={s.name} value={s.name}>{s.name}</option>)}
        </select>
        <span style={{ fontSize: 15, fontWeight: 600, fontFamily: 'var(--font-mono)' }}>
          {currentSpot ? (currentSpot).toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2}) : '—'}
        </span>
        <span style={{ width: 1, height: 18, background: 'var(--border)' }} />
        <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Expiry</span>
        <select value={selectedExpiry || ''} onChange={e => setSelectedExpiry(e.target.value)}
          style={{ background: 'var(--bg-card2)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', padding: '6px 10px', fontSize: 13 }}>
          {expiries.map(exp => <option key={exp} value={exp}>{formatAngelExpiry(exp)}</option>)}
        </select>
      </div>

      {legs.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginBottom: 16 }}>
          {[
            { label: 'Max profit', value: maxProfit === null ? '—' : maxProfit > 1e6 ? 'Unlimited' : (maxProfit > 0 ? '+' : '') + '₹' + (maxProfit).toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2}), color: maxProfit > 0 ? 'var(--profit)' : 'var(--text-primary)' },
            { label: 'Max loss', value: maxLoss === null ? '—' : maxLoss < -1e6 ? 'Unlimited' : '−₹' + Math.abs(maxLoss).toLocaleString('en-IN'), color: maxLoss < 0 ? 'var(--loss)' : 'var(--text-primary)' },
            { label: 'Breakeven', value: breakevens.length ? breakevens.map(b => (b).toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2})).join(' / ') : '—', color: 'var(--text-primary)' },
            { label: 'Reward : Risk', value: riskReward, color: 'var(--text-primary)' },
            { label: 'Net premium', value: (netPrem >= 0 ? '+' : '−') + '₹' + Math.abs(netPrem).toLocaleString('en-IN'), color: netPrem >= 0 ? 'var(--profit)' : 'var(--loss)' },
            { label: 'POP', value: pop !== null ? `${pop}%` : '—', color: pop > 50 ? 'var(--profit)' : pop < 50 ? 'var(--loss)' : 'var(--text-primary)' },
            { label: 'Intrinsic value', value: '₹' + Math.round(Math.abs(intrinsicValue)).toLocaleString('en-IN'), color: 'var(--text-primary)' },
            { label: 'Time value', value: (timeValue >= 0 ? '+' : '−') + '₹' + Math.abs(timeValue).toLocaleString('en-IN'), color: timeValue >= 0 ? 'var(--profit)' : 'var(--loss)' },
          ].map(({ label, value, color }) => (
            <div key={label} style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 8, padding: '10px 12px' }}>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 3 }}>{label}</div>
              <div style={{ fontSize: 15, fontWeight: 600, color }}>{value}</div>
            </div>
          ))}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: legs.length ? '1.4fr 1fr' : '1fr', gap: 16 }}>
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              {['CHAIN', 'GREEKS', 'FUTURES'].map(v => (
                <button key={v} onClick={() => setPickerView(v)}
                  style={{
                    background: pickerView === v ? 'var(--accent)' : 'var(--bg-card2)',
                    color: pickerView === v ? '#fff' : 'var(--text-secondary)',
                    border: 'none', borderRadius: 6, padding: '4px 12px', fontSize: 12, cursor: 'pointer',
                  }}>{v}</button>
              ))}
            </div>
            {loadingChain && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>loading chain…</span>}
            {chainError && <span style={{ fontSize: 11, color: 'var(--loss)' }}>{chainError}</span>}
          </div>

          {pickerView === 'FUTURES' && (() => {
            const months = { JAN:0,FEB:1,MAR:2,APR:3,MAY:4,JUN:5,JUL:6,AUG:7,SEP:8,OCT:9,NOV:10,DEC:11 };
            const expiryRows = expiries.map(exp => {
              const day = parseInt(exp.slice(0,2),10), mo = months[exp.slice(2,5).toUpperCase()??0], yr = parseInt(exp.slice(5),10);
              const expDate = new Date(yr, mo, day, 15, 30);
              const expMs = expDate.getTime();
              const daysLeft = Math.max(0, (expMs - Date.now()) / 864e5);
              const T_exp = daysLeft / 365;
              const fwd = currentSpot ? +(currentSpot * Math.exp(RISK_FREE_RATE * T_exp)).toFixed(2) : null;
              const monthly = isMonthlyExpiry(expDate);
              return { exp, expDate, daysLeft, fwd, monthly };
            });
            const monthlyRows = expiryRows.filter(r => r.monthly);
            const syntheticRows = expiryRows;

            const FutRow = ({ exp, daysLeft, fwd }) => (
              <tr style={{ borderTop: '1px solid var(--border)' }}>
                <td style={{ padding: '10px 10px', fontSize: 13 }}>
                  {(() => { const months2 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']; const d=parseInt(exp.slice(0,2),10),m=months2[months[exp.slice(2,5).toUpperCase()]??0],y=parseInt(exp.slice(5),10); return `${d} ${m} ${y}`; })()}
                  <span style={{ marginLeft: 8, fontSize: 11, color: 'var(--text-muted)' }}>({Math.round(daysLeft)} days)</span>
                </td>
                <td style={{ padding: '10px 10px', textAlign: 'right', fontFamily: 'var(--font-mono)', fontSize: 13 }}>
                  {fwd?.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) ?? '—'}
                </td>
                <td style={{ padding: '10px 10px' }}>
                  {fwd && (
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                      <button onClick={() => addFuturesLeg(exp, fwd, 'BUY')}
                        style={{ background: 'none', border: '1px solid var(--profit)', color: 'var(--profit)', borderRadius: 5, padding: '3px 14px', fontSize: 12, cursor: 'pointer' }}>B</button>
                      <button onClick={() => addFuturesLeg(exp, fwd, 'SELL')}
                        style={{ background: 'none', border: '1px solid var(--loss)', color: 'var(--loss)', borderRadius: 5, padding: '3px 14px', fontSize: 12, cursor: 'pointer' }}>S</button>
                    </div>
                  )}
                </td>
              </tr>
            );

            return (
              <div>
                {monthlyRows.length > 0 && (
                  <>
                    <div style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', padding: '8px 10px', background: 'var(--bg-card2)', borderRadius: 6, marginBottom: 4 }}>Futures</div>
                    <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 16 }}>
                      <thead><tr style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', borderBottom: '1px solid var(--border)' }}>
                        <th style={{ textAlign: 'left', padding: '4px 10px', fontWeight: 400 }}>Expiry</th>
                        <th style={{ textAlign: 'right', padding: '4px 10px', fontWeight: 400 }}>Price</th>
                        <th />
                      </tr></thead>
                      <tbody>{monthlyRows.map(r => <FutRow key={r.exp} {...r} />)}</tbody>
                    </table>
                  </>
                )}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', background: 'var(--bg-card2)', borderRadius: 6, marginBottom: 4 }}>
                  <span style={{ fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Synthetic futures</span>
                  <span style={{ fontSize: 10, color: 'var(--text-muted)', background: 'var(--bg-card)', borderRadius: 10, padding: '1px 7px' }}>ⓘ spot · e^(r·T)</span>
                </div>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead><tr style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', borderBottom: '1px solid var(--border)' }}>
                    <th style={{ textAlign: 'left', padding: '4px 10px', fontWeight: 400 }}>Expiry</th>
                    <th style={{ textAlign: 'right', padding: '4px 10px', fontWeight: 400 }}>Price</th>
                    <th />
                  </tr></thead>
                  <tbody>{syntheticRows.map(r => <FutRow key={r.exp} {...r} />)}</tbody>
                </table>
              </div>
            );
          })()}
          {pickerView !== 'FUTURES' && (
            <div style={{ maxHeight: 480, overflowY: 'auto' }}>
            <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse', tableLayout: 'fixed' }}>
              <thead style={{ position: 'sticky', top: 0, background: 'var(--bg-card)', zIndex: 1 }}>
                {/* Section row: CALLS | — | — | PUTS */}
                <tr style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>
                  <th colSpan={pickerView === 'GREEKS' ? 4 : 3} style={{ textAlign: 'center', padding: '4px 6px 2px', color: 'var(--loss)', letterSpacing: 1 }}>Calls</th>
                  <th style={{ padding: 0 }} />
                  <th style={{ padding: 0 }} />
                  <th colSpan={pickerView === 'GREEKS' ? 4 : 3} style={{ textAlign: 'center', padding: '4px 6px 2px', color: 'var(--profit)', letterSpacing: 1 }}>Puts</th>
                </tr>
                <tr style={{ color: 'var(--text-muted)', fontSize: 10, textTransform: 'uppercase', borderBottom: '1px solid var(--border)' }}>
                  <th style={{ textAlign: 'right', padding: '3px 6px', fontWeight: 400 }}>OI chg%</th>
                  <th style={{ textAlign: 'right', padding: '3px 6px', fontWeight: 400 }}>OI-lakh</th>
                  {pickerView === 'GREEKS' && <th style={{ textAlign: 'right', padding: '3px 6px', fontWeight: 400 }}>Delta</th>}
                  <th style={{ textAlign: 'right', padding: '3px 6px', fontWeight: 400 }}>{pickerView === 'GREEKS' ? 'θ' : 'LTP'}</th>
                  <th style={{ textAlign: 'center', padding: '3px 8px', fontWeight: 400 }}>Strike</th>
                  <th style={{ textAlign: 'center', padding: '3px 6px', fontWeight: 400 }}>IV</th>
                  <th style={{ textAlign: 'left', padding: '3px 6px', fontWeight: 400 }}>{pickerView === 'GREEKS' ? 'θ' : 'LTP'}</th>
                  {pickerView === 'GREEKS' && <th style={{ textAlign: 'left', padding: '3px 6px', fontWeight: 400 }}>Delta</th>}
                  <th style={{ textAlign: 'left', padding: '3px 6px', fontWeight: 400 }}>OI-lakh</th>
                  <th style={{ textAlign: 'left', padding: '3px 6px', fontWeight: 400 }}>OI chg%</th>
                </tr>
              </thead>
              <tbody ref={tableBodyRef}>
                {chainRows.map(row => {
                  const isAtm = spot && Math.abs(row.strike - spot) === Math.min(...chainRows.map(r => Math.abs(r.strike - spot)));
                  const showBtns = isAtm || hoveredStrike === row.strike;
                  const ceChg = oiChangePct(row.CE);
                  const peChg = oiChangePct(row.PE);
                  const ceOiL = row.CE ? (row.CE.oi / 100000) : 0;
                  const peOiL = row.PE ? (row.PE.oi / 100000) : 0;
                  const ceOiPct = maxOi > 0 ? Math.min(100, (row.CE?.oi || 0) / maxOi * 100) : 0;
                  const peOiPct = maxOi > 0 ? Math.min(100, (row.PE?.oi || 0) / maxOi * 100) : 0;

                  // Find legs at this strike — one per optionType/transactionType combo
                  const ceBuyLeg  = legs.find(l => l.strike === row.strike && l.optionType === 'CE' && l.transactionType === 'BUY');
                  const ceSellLeg = legs.find(l => l.strike === row.strike && l.optionType === 'CE' && l.transactionType === 'SELL');
                  const peBuyLeg  = legs.find(l => l.strike === row.strike && l.optionType === 'PE' && l.transactionType === 'BUY');
                  const peSellLeg = legs.find(l => l.strike === row.strike && l.optionType === 'PE' && l.transactionType === 'SELL');
                  const hasAnyCeLeg = ceBuyLeg || ceSellLeg;
                  const hasAnyPeLeg = peBuyLeg || peSellLeg;

                  const LegBadge = ({ leg, side }) => leg ? (
                    <span style={{
                      fontSize: 10, fontWeight: 700, padding: '1px 5px', borderRadius: 3, lineHeight: 1.5,
                      background: side === 'BUY' ? 'var(--profit-dim)' : 'var(--loss-dim)',
                      color: side === 'BUY' ? 'var(--profit)' : 'var(--loss)',
                      border: `1px solid ${side === 'BUY' ? 'rgba(16,217,160,0.3)' : 'rgba(240,86,110,0.3)'}`,
                      whiteSpace: 'nowrap',
                    }}>
                      {side === 'BUY' ? 'B' : 'S'} {leg.quantity > 1 ? `${leg.quantity}×` : ''}
                    </span>
                  ) : null;

                  const rowBg = isAtm ? 'rgba(59,130,246,0.06)' : (hasAnyCeLeg || hasAnyPeLeg) ? 'rgba(59,130,246,0.03)' : hoveredStrike === row.strike ? 'var(--bg-card2)' : 'transparent';
                  return (
                    <tr key={row.strike}
                      ref={isAtm ? atmRowRef : null}
                      onMouseEnter={() => setHoveredStrike(row.strike)}
                      onMouseLeave={() => setHoveredStrike(prev => prev === row.strike ? null : prev)}
                      style={{ background: rowBg, borderTop: isAtm ? '1px solid rgba(59,130,246,0.35)' : 'none', borderBottom: isAtm ? '1px solid rgba(59,130,246,0.35)' : 'none' }}>

                      {/* OI chg% — call */}
                      <td style={{ textAlign: 'right', padding: '5px 6px', color: ceChg === null ? 'var(--text-muted)' : ceChg >= 0 ? 'var(--profit)' : 'var(--loss)', fontSize: 11 }}>
                        {ceChg === null ? '—' : `${ceChg >= 0 ? '+' : ''}${Math.round(ceChg)}%`}
                      </td>

                      {/* OI-lakh + embedded bar — call (bar fills from right) */}
                      <td style={{ padding: '5px 6px', textAlign: 'right', minWidth: 80 }}>
                        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 4 }}>
                          <span style={{ fontSize: 11, color: 'var(--text-secondary)', minWidth: 28, textAlign: 'right' }}>
                            {ceOiL > 0 ? ceOiL.toFixed(1) : '—'}
                          </span>
                          <div style={{ width: 40, height: 8, background: 'var(--bg-card2)', borderRadius: 2, overflow: 'hidden' }}>
                            <div style={{ marginLeft: 'auto', width: `${ceOiPct}%`, height: 8, background: 'rgba(239,68,68,0.55)', borderRadius: 2 }} />
                          </div>
                        </div>
                      </td>

                      {/* Delta — call (GREEKS only) */}
                      {pickerView === 'GREEKS' && (
                        <td style={{ textAlign: 'right', padding: '5px 6px', color: 'var(--text-secondary)' }}>{fmt(row.CE?.delta, 2)}</td>
                      )}

                      {/* LTP / Theta — call */}
                      <td style={{ textAlign: 'right', padding: '5px 6px', minWidth: 90 }}>
                        {row.CE ? (
                          <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 4 }}>
                            {showBtns && (
                              <button onClick={() => addLeg(row.strike, 'CE', 'BUY')} title="Buy CE"
                                style={{ background: 'none', border: '1px solid var(--profit)', color: 'var(--profit)', borderRadius: 3, padding: '1px 5px', fontSize: 10, cursor: 'pointer', lineHeight: 1.4 }}>B</button>
                            )}
                            {!showBtns && <LegBadge leg={ceBuyLeg} side="BUY" />}
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: isAtm ? 'var(--accent)' : 'var(--text-primary)' }}>
                              {pickerView === 'GREEKS' ? fmt(row.CE.theta) : fmt(row.CE.ltp)}
                            </span>
                            {!showBtns && <LegBadge leg={ceSellLeg} side="SELL" />}
                            {showBtns && (
                              <button onClick={() => addLeg(row.strike, 'CE', 'SELL')} title="Sell CE"
                                style={{ background: 'none', border: '1px solid var(--loss)', color: 'var(--loss)', borderRadius: 3, padding: '1px 5px', fontSize: 10, cursor: 'pointer', lineHeight: 1.4 }}>S</button>
                            )}
                          </div>
                        ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                      </td>

                      {/* Strike */}
                      <td style={{ textAlign: 'center', padding: '5px 8px', fontWeight: isAtm ? 600 : 400, fontFamily: 'var(--font-mono)', color: isAtm ? 'var(--text-primary)' : 'var(--text-secondary)', background: 'var(--bg-card2)', borderLeft: '1px solid var(--border)', borderRight: '1px solid var(--border)' }}>
                        {row.strike.toLocaleString('en-IN')}
                      </td>

                      {/* IV */}
                      <td style={{ textAlign: 'center', padding: '5px 6px', color: 'var(--text-muted)', fontSize: 11, borderRight: '1px solid var(--border)' }}>
                        {row.CE?.iv ? fmt(row.CE.iv, 1) : row.PE?.iv ? fmt(row.PE.iv, 1) : '—'}
                      </td>

                      {/* LTP / Theta — put */}
                      <td style={{ textAlign: 'left', padding: '5px 6px', minWidth: 90 }}>
                        {row.PE ? (
                          <div style={{ display: 'flex', justifyContent: 'flex-start', alignItems: 'center', gap: 4 }}>
                            {showBtns && (
                              <button onClick={() => addLeg(row.strike, 'PE', 'BUY')} title="Buy PE"
                                style={{ background: 'none', border: '1px solid var(--profit)', color: 'var(--profit)', borderRadius: 3, padding: '1px 5px', fontSize: 10, cursor: 'pointer', lineHeight: 1.4 }}>B</button>
                            )}
                            {!showBtns && <LegBadge leg={peBuyLeg} side="BUY" />}
                            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: isAtm ? 'var(--accent)' : 'var(--text-primary)' }}>
                              {pickerView === 'GREEKS' ? fmt(row.PE.theta) : fmt(row.PE.ltp)}
                            </span>
                            {!showBtns && <LegBadge leg={peSellLeg} side="SELL" />}
                            {showBtns && (
                              <button onClick={() => addLeg(row.strike, 'PE', 'SELL')} title="Sell PE"
                                style={{ background: 'none', border: '1px solid var(--loss)', color: 'var(--loss)', borderRadius: 3, padding: '1px 5px', fontSize: 10, cursor: 'pointer', lineHeight: 1.4 }}>S</button>
                            )}
                          </div>
                        ) : <span style={{ color: 'var(--text-muted)' }}>—</span>}
                      </td>

                      {/* Delta — put (GREEKS only) */}
                      {pickerView === 'GREEKS' && (
                        <td style={{ textAlign: 'left', padding: '5px 6px', color: 'var(--text-secondary)' }}>{fmt(row.PE?.delta, 2)}</td>
                      )}

                      {/* OI-lakh + embedded bar — put (bar fills from left) */}
                      <td style={{ padding: '5px 6px', minWidth: 80 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                          <div style={{ width: 40, height: 8, background: 'var(--bg-card2)', borderRadius: 2, overflow: 'hidden' }}>
                            <div style={{ width: `${peOiPct}%`, height: 8, background: 'rgba(34,197,94,0.55)', borderRadius: 2 }} />
                          </div>
                          <span style={{ fontSize: 11, color: 'var(--text-secondary)', minWidth: 28 }}>
                            {peOiL > 0 ? peOiL.toFixed(1) : '—'}
                          </span>
                        </div>
                      </td>

                      {/* OI chg% — put */}
                      <td style={{ textAlign: 'left', padding: '5px 6px', color: peChg === null ? 'var(--text-muted)' : peChg >= 0 ? 'var(--profit)' : 'var(--loss)', fontSize: 11 }}>
                        {peChg === null ? '—' : `${peChg >= 0 ? '+' : ''}${Math.round(peChg)}%`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          )}
        </div>

        {legs.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Legs */}
            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Legs ({legs.length})</div>
                <div style={{ display: 'flex', gap: 10 }}>
                  <button onClick={() => setShowDrafts(s => !s)}
                    style={{ background: showDrafts ? 'var(--accent-dim)' : 'none', border: '1px solid var(--border)', color: 'var(--accent)', fontSize: 11, cursor: 'pointer', borderRadius: 5, padding: '2px 8px' }}>
                    {drafts.length > 0 ? `Drafts (${drafts.length})` : 'Drafts'}
                  </button>
                  <button onClick={saveDraft}
                    style={{ background: 'var(--accent)', border: 'none', color: '#fff', fontSize: 11, cursor: 'pointer', borderRadius: 5, padding: '2px 10px' }}>
                    Save draft
                  </button>
                  <button onClick={clearAllLegs} style={{ background: 'none', border: 'none', color: 'var(--loss)', fontSize: 11, cursor: 'pointer' }}>Clear all</button>
                </div>
              </div>
              {showDrafts && drafts.length > 0 && (
                <div style={{ marginBottom: 12, background: 'var(--bg-card2)', borderRadius: 8, overflow: 'hidden' }}>
                  {drafts.map(d => (
                    <div key={d.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '7px 10px', borderBottom: '1px solid var(--border)', fontSize: 12 }}>
                      <button onClick={() => loadDraft(d)}
                        style={{ background: 'none', border: 'none', color: 'var(--accent)', cursor: 'pointer', textAlign: 'left', fontSize: 12, padding: 0 }}>
                        {d.name}
                        <span style={{ marginLeft: 8, color: 'var(--text-muted)', fontSize: 10 }}>{d.legs.length} leg{d.legs.length !== 1 ? 's' : ''}</span>
                      </button>
                      <button onClick={() => deleteDraft(d.id)} style={{ background: 'none', border: 'none', color: 'var(--text-muted)', cursor: 'pointer', fontSize: 14, padding: 0 }}>×</button>
                    </div>
                  ))}
                  {showDrafts && drafts.length === 0 && (
                    <div style={{ padding: '10px', color: 'var(--text-muted)', fontSize: 12 }}>No drafts saved yet.</div>
                  )}
                </div>
              )}
              {legs.map(leg => (
                <div key={leg.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '6px 0', borderTop: '1px solid var(--border)', fontSize: 12 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <span style={{
                      display: 'inline-block', width: 16, height: 16, borderRadius: 3, textAlign: 'center', lineHeight: '16px',
                      fontSize: 10, fontWeight: 700,
                      background: leg.transactionType === 'SELL' ? 'var(--loss-dim)' : 'var(--profit-dim)',
                      color: leg.transactionType === 'SELL' ? 'var(--loss)' : 'var(--profit)',
                    }}>{leg.transactionType === 'SELL' ? 'S' : 'B'}</span>
                    <input type="number" min={1} value={leg.quantity} onChange={e => updateLegQty(leg.id, parseInt(e.target.value, 10) || 1)}
                      style={{ width: 36, background: 'var(--bg-card2)', border: '1px solid var(--border)', borderRadius: 4, color: 'var(--text-primary)', fontSize: 12, padding: '2px 4px' }} />
                    <span style={{ color: 'var(--text-primary)' }}>× {leg.strike.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {leg.optionType}</span>
                    <span style={{ fontSize: 10, color: 'var(--text-muted)', background: 'var(--bg-card2)', borderRadius: 4, padding: '1px 5px' }}>
                      {leg.optionType === 'FUT' && leg.expiry ? formatAngelExpiry(leg.expiry) : (selectedExpiry ? formatAngelExpiry(selectedExpiry) : '—')}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', fontSize: 11 }}>{fmt(leg.premium)}</span>
                    <button onClick={() => removeLeg(leg.id)} style={{ background: 'none', border: 'none', color: 'var(--loss)', cursor: 'pointer', fontSize: 14, padding: 0 }}>×</button>
                  </div>
                </div>
              ))}
            </div>

            {/* Greeks */}
            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px' }}>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 10 }}>Greeks</div>
              {[['Delta', fmt(greeks.delta, 2)], ['Gamma', fmt(greeks.gamma, 4)], ['Theta / day', fmt(greeks.theta, 2)], ['Vega', fmt(greeks.vega, 2)]].map(([label, val]) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderTop: '1px solid var(--border)', fontSize: 13 }}>
                  <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 600 }}>{val}</span>
                </div>
              ))}
            </div>

            {/* Standard deviation + Implied futures + DTE */}
            <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px' }}>
              <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 10 }}>Standard deviation</div>
              {[['1 SD', sd.sd1.toFixed(2)], ['2 SD', sd.sd2.toFixed(2)]].map(([label, val]) => (
                <div key={label} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderTop: '1px solid var(--border)', fontSize: 13 }}>
                  <span style={{ color: 'var(--text-secondary)' }}>{label}</span>
                  <span style={{ fontFamily: 'var(--font-mono)' }}>{val}</span>
                </div>
              ))}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px' }}>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 4 }}>Days to expiry</div>
                <div style={{ fontSize: 18, fontWeight: 600 }}>{daysToExpiry.toFixed(1)}</div>
              </div>
              <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: '12px 14px' }}>
                <div style={{ fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 4 }}>Implied futures</div>
                <div style={{ fontSize: 18, fontWeight: 600 }}>{futuresPrice ? (futuresPrice).toLocaleString('en-IN', {minimumFractionDigits: 2, maximumFractionDigits: 2}) : '—'}</div>
              </div>
            </div>
          </div>
        )}
      </div>

      {legs.length > 0 && chartPoints.length > 1 && (
        <div style={{ background: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: 10, padding: '14px 16px', marginTop: 16 }}>
          {/* Header row: P&L readout — same format as OptionsAnalyzer */}
          {(() => {
            const readSpot = chartHoverSpot ?? currentSpot;
            const readPnl = readSpot != null ? payoffAt(calibratedLegs, readSpot, T_chart, RISK_FREE_RATE, isCurrentMoment && !chartHoverSpot) : null;
            const pnlText = readPnl != null
              ? `${readPnl >= 0 ? '+' : '−'}₹${Math.abs(readPnl).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
              : '—';
            const label = chartHoverSpot
              ? `At ${readSpot.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}: `
              : (readPnl == null || readPnl >= 0 ? 'Projected profit: ' : 'Projected loss: ');
            return (
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  {label}<span style={{ color: readPnl == null ? 'var(--text-muted)' : readPnl >= 0 ? 'var(--profit)' : 'var(--loss)' }}>{pnlText}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: 11, color: 'var(--text-muted)' }}>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><span style={{ display: 'inline-block', width: 20, height: 2, background: 'var(--profit)' }} /> Today</span>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}><span style={{ display: 'inline-block', width: 20, height: 2, borderTop: '2px dashed rgba(228,235,248,0.4)' }} /> At expiry</span>
                </div>
              </div>
            );
          })()}

          {/* SVG payoff chart — identical structure to OptionsAnalyzer */}
          {(() => {
            const W = 700, H = 280, padL = 46, padR = 16, padT = 16, padB = 30;
            const plotW = W - padL - padR;
            const plotH = H - padT - padB;
            const xScale = s => padL + ((s - spotMin) / (spotMax - spotMin)) * plotW;
            const xToSpot = x => spotMin + ((x - padL) / plotW) * (spotMax - spotMin);
            const yScale = v => padT + plotH / 2 - (v / maxAbsPnl) * (plotH / 2);
            const zeroY = yScale(0);
            const expiryPath = chartPoints.map((p, i) => `${i === 0 ? 'M' : 'L'}${xScale(p.spot)},${yScale(p.onExpiry)}`).join(' ');
            const targetPath = chartPoints.map((p, i) => `${i === 0 ? 'M' : 'L'}${xScale(p.spot)},${yScale(p.onTarget)}`).join(' ');
            const lossAreaPath = `${expiryPath} L${xScale(spotMax)},${zeroY} L${xScale(spotMin)},${zeroY} Z`;
            const hoverX = chartHoverSpot ? xScale(chartHoverSpot) : null;
            const hoverPnlExpiry = chartHoverSpot ? payoffAt(calibratedLegs, chartHoverSpot, 0) : null;
            const hoverPnlToday = chartHoverSpot ? payoffAt(calibratedLegs, chartHoverSpot, T_chart) : null;
            return (
              <svg ref={chartSvgRef} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
                style={{ width: '100%', height: 280, cursor: 'crosshair' }}
                onMouseMove={e => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const svgX = ((e.clientX - rect.left) / rect.width) * W;
                  if (svgX < padL || svgX > W - padR) { setChartHoverSpot(null); return; }
                  setChartHoverSpot(Math.round(Math.max(spotMin, Math.min(spotMax, xToSpot(svgX))) / 10) * 10);
                }}
                onMouseLeave={() => setChartHoverSpot(null)}>
                {[0.25, 0.5, 0.75].map(frac => (
                  <line key={frac} x1={padL} y1={padT + plotH * frac} x2={W - padR} y2={padT + plotH * frac} stroke="rgba(255,255,255,0.04)" />
                ))}
                {chainRows.map(row => {
                  const barW = Math.max(plotW / Math.max(chainRows.length, 1) * 0.5, 2);
                  const results = [];
                  if (row.CE?.oi > 0 && maxOi > 0) {
                    const ceH = Math.min((row.CE.oi / maxOi) * (plotH * 0.28), plotH * 0.28);
                    results.push(<rect key={`ce-${row.strike}`} x={xScale(row.strike) - barW} y={zeroY - ceH} width={barW} height={ceH} fill="rgba(240,86,110,0.45)" />);
                  }
                  if (row.PE?.oi > 0 && maxOi > 0) {
                    const peH = Math.min((row.PE.oi / maxOi) * (plotH * 0.28), plotH * 0.28);
                    results.push(<rect key={`pe-${row.strike}`} x={xScale(row.strike)} y={zeroY - peH} width={barW} height={peH} fill="rgba(16,217,160,0.45)" />);
                  }
                  return results;
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
                        Spot: {currentSpot.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </text>
                    </>
                  );
                })()}
                {hoverX && (
                  <>
                    <line x1={hoverX} y1={padT} x2={hoverX} y2={H - padB} stroke="rgba(255,255,255,0.2)" strokeWidth="1" />
                    {hoverPnlToday != null && <circle cx={hoverX} cy={yScale(hoverPnlToday)} r={4} fill="var(--profit)" stroke="var(--bg-card)" strokeWidth="2" />}
                    {hoverPnlExpiry != null && <circle cx={hoverX} cy={yScale(hoverPnlExpiry)} r={3} fill="rgba(228,235,248,0.5)" stroke="var(--bg-card)" strokeWidth="2" />}
                  </>
                )}
                {[0, 0.25, 0.5, 0.75, 1].map(frac => {
                  const val = spotMin + (spotMax - spotMin) * frac;
                  return (
                    <text key={frac} x={xScale(val)} y={H - 8} fontSize="10" fill="var(--text-muted)" textAnchor="middle">
                      {val.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </text>
                  );
                })}
              </svg>
            );
          })()}

          {/* Spot price slider + direct input */}
          <div style={{ marginTop: 10, marginBottom: 16 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 11, color: 'var(--text-secondary)', marginBottom: 6 }}>
              <span>Target spot price</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="number"
                  value={scenarioSpot ?? Math.round(spot ?? 0)}
                  onChange={e => { const v = parseFloat(e.target.value); if (!isNaN(v)) setScenarioSpot(v); }}
                  style={{ width: 90, background: 'var(--bg-card2)', border: '1px solid var(--border)', borderRadius: 5, color: 'var(--text-primary)', fontSize: 12, padding: '3px 6px', fontFamily: 'var(--font-mono)', textAlign: 'right' }}
                />
                {scenarioSpot !== null && (
                  <button onClick={() => setScenarioSpot(null)} style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: 11, cursor: 'pointer', padding: 0 }}>reset</button>
                )}
              </div>
            </div>
            <input type="range" min={spotMin} max={spotMax} step={0.05} value={currentSpot}
              onChange={e => setScenarioSpot(parseFloat(e.target.value))}
              style={{ width: '100%', accentColor: 'var(--accent)' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
              <span>{spotMin.toLocaleString('en-IN')}</span>
              <span>{spotMax.toLocaleString('en-IN')}</span>
            </div>
          </div>

          {/* Time slider — market hours only (Mon–Fri 09:15–15:30 IST) */}
          <div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
              <span>Target date</span>
              {clampedIdx > 0 && (
                <button onClick={() => setSliderIdx(0)} style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: 11, cursor: 'pointer', padding: 0 }}>reset</button>
              )}
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <button
                onClick={() => setSliderIdx(i => Math.max(0, i - 1))}
                style={{ background: 'var(--bg-card2)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', width: 28, height: 28, cursor: 'pointer', fontSize: 14 }}>‹</button>
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
                style={{ background: 'var(--bg-card2)', border: '1px solid var(--border)', borderRadius: 6, color: 'var(--text-primary)', width: 28, height: 28, cursor: 'pointer', fontSize: 14 }}>›</button>
            </div>
            <input type="range" min={0} max={marketTimestamps.length - 1} step={1} value={clampedIdx}
              onChange={e => setSliderIdx(parseInt(e.target.value, 10))}
              style={{ width: '100%', accentColor: '#FFA53D' }} />
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: 'var(--text-muted)', marginTop: 2 }}>
              <span>Now · {new Date(nowMs).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}</span>
              <span>Expiry · {new Date(expiryMs).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}</span>
            </div>
          </div>
        </div>
      )}

      {legs.length === 0 && (
        <div style={{ textAlign: 'center', padding: '60px 0', color: 'var(--text-muted)', fontSize: 13 }}>
          Hover a strike's price and click B or S to start building a strategy.
        </div>
      )}
    </div>
  );
}
