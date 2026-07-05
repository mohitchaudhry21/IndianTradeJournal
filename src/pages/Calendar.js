import React, { useState, useMemo } from 'react';
import { useTrades } from '../context/TradesContext';

const MONTHS   = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const fmt      = n => `${n>=0?'+':'-'}$${Math.abs(n).toFixed(2)}`;
const fmtShort = n => { const a=Math.abs(n),s=n>=0?'+':'-'; return a>=1000?`${s}$${(a/1000).toFixed(1)}k`:`${s}$${a.toFixed(2)}`; };

export default function Calendar() {
  const { trades, stats } = useTrades();
  const brokeragePerLot = stats.brokeragePerLot || 0;

  const initMonth = useMemo(() => {
    const valid = trades.filter(t => !t.isWithdrawal && !t.isDeposit && (t.exitDate||t.entryDate));
    if (!valid.length) return new Date();
    const d = [...valid].sort((a,b)=>(b.exitDate||b.entryDate).localeCompare(a.exitDate||a.entryDate))[0];
    const dt = d.exitDate || d.entryDate;
    return new Date(parseInt(dt.slice(0,4)), parseInt(dt.slice(5,7))-1, 1);
  }, []);

  const [current,       setCurrent]       = useState(initMonth);
  const [selected,      setSelected]      = useState(null); // date string
  const [selectedWeek,  setSelectedWeek]  = useState(null); // week index
  const [detailMode,    setDetailMode]    = useState('day'); // 'day' | 'week'

  const year  = current.getFullYear();
  const month = current.getMonth();

  const daysInMonth = new Date(year, month+1, 0).getDate();
  const firstDOW    = new Date(year, month, 1).getDay();
  const offset      = firstDOW === 0 ? 6 : firstDOW - 1;
  const totalWeeks  = Math.ceil((offset + daysInMonth) / 7);

  const ds    = d => `${year}-${String(month+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  const dn    = (wi, di) => wi * 7 + di - offset + 1;

  const dsAny = (d) => {
    if (d >= 1 && d <= daysInMonth) return ds(d);
    if (d < 1) {
      const prev = new Date(year, month, 0);
      const prevDay = prev.getDate() + d;
      return `${prev.getFullYear()}-${String(prev.getMonth()+1).padStart(2,'0')}-${String(prevDay).padStart(2,'0')}`;
    }
    const nextDate = new Date(year, month+1, d - daysInMonth);
    return `${nextDate.getFullYear()}-${String(nextDate.getMonth()+1).padStart(2,'0')}-${String(nextDate.getDate()).padStart(2,'0')}`;
  };

  const tradeComm = t => brokeragePerLot > 0 ? brokeragePerLot * (t.size||0) : (t.fees||0);

  const dayMap = useMemo(() => {
    const sd = stats.statsStartDate || '';
    const ed = stats.statsEndDate   || '';
    const tradeMap = {};
    const wdMap    = {};

    trades.forEach(t => {
      const d = t.exitDate || t.entryDate;
      if (!d) return;
      if (t.isOpen || t.status === 'Open') return;

      if (t.isWithdrawal || t.isDeposit) {
        const wd = t.entryDate || t.exitDate;
        if (!wd) return;
        if (!wdMap[wd]) wdMap[wd] = { amount:0, deposits:0, count:0 };
        if (t.isWithdrawal) wdMap[wd].amount   += Math.abs(t.pnl||0);
        if (t.isDeposit)    wdMap[wd].deposits += Math.abs(t.pnl||0);
        wdMap[wd].count++;
        return;
      }

      if (sd && d < sd) return;
      if (ed && d > ed) return;

      if (!tradeMap[d]) tradeMap[d] = { pnl:0, comm:0, count:0, wins:0, losses:0, trades:[] };
      tradeMap[d].pnl   += parseFloat(t.pnl||0);
      tradeMap[d].comm  += tradeComm(t);
      tradeMap[d].count++;
      tradeMap[d].trades.push(t);
      if (t.status === 'Win')  tradeMap[d].wins++;
      if (t.status === 'Loss') tradeMap[d].losses++;
    });

    Object.values(tradeMap).forEach(v => {
      v.pnl  = parseFloat(v.pnl.toFixed(2));
      v.comm = parseFloat(v.comm.toFixed(2));
    });
    return { tradeMap, wdMap };
  }, [trades, stats.statsStartDate, stats.statsEndDate, brokeragePerLot]);

  const { tradeMap, wdMap } = dayMap;

  // Compute max absolute PNL in current month for intensity scaling
  const monthMaxAbs = useMemo(() => {
    let max = 0;
    for (let d = 1; d <= daysInMonth; d++) {
      const cell = tradeMap[ds(d)];
      if (cell) max = Math.max(max, Math.abs(cell.pnl));
    }
    return max || 1;
  }, [tradeMap, daysInMonth, year, month]);

  // Detect light mode for vivid calendar colors
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  const calColor = (isProfit, intensity) => {
    if (isLight) {
      return isProfit
        ? `rgba(37,99,235,${(0.15 + 0.55 * intensity).toFixed(2)})`
        : `rgba(220,38,38,${(0.12 + 0.48 * intensity).toFixed(2)})`;
    }
    return isProfit
      ? `rgba(59,130,246,${(0.08 + 0.32 * intensity).toFixed(2)})`
      : `rgba(239,68,68,${(0.08 + 0.32 * intensity).toFixed(2)})`;
  };
  const calBorder = (isProfit, intensity) => {
    if (isLight) {
      return isProfit
        ? `1px solid rgba(37,99,235,${(0.25 + 0.4 * intensity).toFixed(2)})`
        : `1px solid rgba(220,38,38,${(0.2 + 0.4 * intensity).toFixed(2)})`;
    }
    return isProfit
      ? `1px solid rgba(59,130,246,.35)`
      : `1px solid rgba(239,68,68,.35)`;
  };

  const fmtDetailDate = d => {
    if (!d) return '';
    return new Date(d+'T12:00:00').toLocaleDateString('en-US',{month:'long',day:'numeric',year:'numeric'});
  };

  const monthPnl = useMemo(() => {
    let t=0; for(let d=1;d<=daysInMonth;d++) t+=tradeMap[ds(d)]?.pnl??0;
    return parseFloat(t.toFixed(2));
  }, [tradeMap, daysInMonth, year, month]);

  const weekData = wi => {
    let pnl=0, comm=0, tradedDays=0, wWins=0, wLosses=0;
    const days=[];
    for(let di=0;di<7;di++){
      const d=dn(wi,di);
      const dateStr=dsAny(d);
      const cell=tradeMap[dateStr];
      days.push({ d, dateStr, cell });
      if(cell){ pnl+=cell.pnl; comm+=cell.comm; tradedDays++; wWins+=cell.wins||0; wLosses+=cell.losses||0; }
    }
    return { pnl:parseFloat(pnl.toFixed(2)), comm:parseFloat(comm.toFixed(2)), tradedDays, days, wins:wWins, losses:wLosses };
  };

  const today   = new Date().toISOString().slice(0,10);
  const selCell = (detailMode==='day' && selected) ? tradeMap[selected] : null;
  const selWd   = (detailMode==='day' && selected) ? wdMap[selected]    : null;
  const selWeekData = (detailMode==='week' && selectedWeek!==null) ? weekData(selectedWeek) : null;

  const handleDayClick = (date, hasTrades, hasWd) => {
    if (!hasTrades && !hasWd) return;
    setSelected(date);
    setDetailMode('day');
    setSelectedWeek(null);
  };

  const handleWeekClick = (wi, wp) => {
    if (wp.tradedDays === 0) return;
    setSelectedWeek(wi);
    setDetailMode('week');
    setSelected(null);
  };

  // Collect all trades in a week for the weekly detail panel
  const weekAllTrades = selWeekData
    ? selWeekData.days.flatMap(({ cell }) => cell ? cell.trades : [])
    : [];

  return (
    <div style={{ display:'flex', flexDirection:'column', height:'100vh', overflow:'hidden' }}>
      {/* Header */}
      <div className="page-header" style={{ flexShrink:0 }}>
        <div style={{display:'flex',alignItems:'center',gap:12}}>
          <div className="page-title">Trading Calendar</div>
          <div style={{fontSize:11,color:'var(--text-muted)'}}>Click day or week for breakdown</div>
          {(stats.statsStartDate||stats.statsEndDate) && (
            <span style={{background:'rgba(59,130,246,.15)',color:'var(--blue-bright)',borderRadius:5,padding:'2px 8px',fontSize:11,fontWeight:600}}>
              📅 {stats.statsStartDate||'all'} → {stats.statsEndDate||'today'}
            </span>
          )}
        </div>
        <div style={{display:'flex',alignItems:'center',gap:10}}>
          <span className={monthPnl>=0?'pos':'neg'} style={{fontWeight:800,fontSize:15}}>
            Monthly: {fmt(monthPnl)}
          </span>
          <button className="btn-icon" onClick={()=>{setCurrent(new Date(year,month-1,1));setSelected(null);setSelectedWeek(null);}}>‹</button>
          <span style={{fontWeight:700,fontSize:15,minWidth:140,textAlign:'center'}}>{MONTHS[month]} {year}</span>
          <button className="btn-icon" onClick={()=>{setCurrent(new Date(year,month+1,1));setSelected(null);setSelectedWeek(null);}}>›</button>
        </div>
      </div>

      {/* Main grid */}
      <div style={{ display:'grid', gridTemplateColumns:'1fr 300px', flex:1, overflow:'hidden', padding:'14px', paddingTop:'10px', gap:14 }}>

        {/* Calendar grid */}
        <div className="card" style={{ padding:'14px', display:'flex', flexDirection:'column', overflow:'hidden' }}>
          {/* Day headers */}
          <div style={{display:'grid',gridTemplateColumns:'repeat(7,1fr) 120px',gap:5,marginBottom:6,flexShrink:0}}>
            {['MON','TUE','WED','THU','FRI','SAT','SUN'].map(d=>(
              <div key={d} style={{textAlign:'center',fontSize:11,fontWeight:700,color:'var(--text-muted)',letterSpacing:'.5px',padding:'4px 0'}}>{d}</div>
            ))}
            <div style={{textAlign:'center',fontSize:11,fontWeight:700,color:'var(--blue-bright)',letterSpacing:'.5px',padding:'4px 0'}}>WEEKLY ↗</div>
          </div>

          {/* Week rows */}
          <div style={{ flex:1, display:'flex', flexDirection:'column', gap:5 }}>
          {Array.from({length:totalWeeks},(_,wi)=>{
            const wp = weekData(wi);
            const isSelWeek = detailMode==='week' && selectedWeek===wi;
            return (
              <div key={wi} style={{display:'grid',gridTemplateColumns:'repeat(7,1fr) 120px',gap:5,flex:1}}>
                {Array.from({length:7},(_,di)=>{
                  const d    = dn(wi,di);
                  if (d<1||d>daysInMonth) return <div key={di} style={{flex:1,borderRadius:7,background:'rgba(255,255,255,.01)'}}/>;
                  const date  = ds(d);
                  const cell  = tradeMap[date];
                  const wd    = wdMap[date];
                  const pos   = cell && cell.pnl >= 0;
                  const isTod = date === today;
                  const isSel = detailMode==='day' && selected === date;

                  return (
                    <div key={di}
                      onClick={()=>handleDayClick(date, !!cell, !!wd)}
                      style={{
                        borderRadius:7, padding:'6px 8px', boxSizing:'border-box',
                        cursor:(cell||wd)?'pointer':'default',
                        background: cell
                          ? calColor(pos, Math.abs(cell.pnl)/monthMaxAbs)
                          : (isLight ? '#f3f6fa' : 'rgba(255,255,255,.03)'),
                        border: isSel
                          ? `2px solid ${pos?'var(--blue)':'var(--red)'}`
                          : isTod
                            ? (isLight ? '2px solid #2563eb' : '2px solid rgba(59,130,246,.7)')
                            : cell
                              ? calBorder(pos, Math.abs(cell.pnl)/monthMaxAbs)
                              : (isLight ? '1px solid #dde3eb' : '1px solid rgba(255,255,255,.07)'),
                        transition:'all .12s',
                        display:'flex', flexDirection:'column', minHeight:0,
                        boxShadow: isTod?'0 0 0 1px rgba(59,130,246,.2)':'none',
                      }}>
                      {/* Day number */}
                      <div style={{
                        fontSize:13, fontWeight:700, lineHeight:1,
                        color: isTod ? (isLight ? '#1d4ed8' : '#60a5fa') : cell ? (isLight ? '#1e293b' : 'rgba(255,255,255,.9)') : (isLight ? '#94a3b8' : 'rgba(255,255,255,.3)'),
                        marginBottom:3,
                      }}>{d}</div>

                      {/* P&L */}
                      {cell && (
                        <div style={{fontSize:13,fontWeight:900,color:pos?(isLight?'#1d4ed8':'#60a5fa'):(isLight?'#dc2626':'#f87171'),lineHeight:1,letterSpacing:'-0.3px'}}>
                          {fmtShort(cell.pnl)}
                        </div>
                      )}

                      {/* Win rate */}
                      {cell && (cell.wins+cell.losses) > 0 && (
                        <div style={{fontSize:10,fontWeight:700,lineHeight:1,marginTop:2,
                          color: cell.wins/(cell.wins+cell.losses)>=0.5
                            ? (isLight?'rgba(29,78,216,0.7)':'rgba(96,165,250,0.7)')
                            : (isLight?'rgba(220,38,38,0.7)':'rgba(248,113,113,0.7)'),
                        }}>
                          {Math.round(cell.wins/(cell.wins+cell.losses)*100)}%
                        </div>
                      )}

                      {/* Withdrawal / Deposit badges */}
                      {wd && (
                        <div style={{display:'flex',flexDirection:'column',gap:1,marginTop:cell?3:0}}>
                          {wd.amount   > 0 && <div style={{fontSize:10,fontWeight:700,color:'#f59e0b',lineHeight:1}}>💸 -{wd.amount.toFixed(0)}</div>}
                          {wd.deposits > 0 && <div style={{fontSize:10,fontWeight:700,color:'#4ade80',lineHeight:1}}>💰 +{wd.deposits.toFixed(0)}</div>}
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* Weekly summary cell — clickable */}
                <div
                  onClick={()=>handleWeekClick(wi,wp)}
                  style={{
                    borderRadius:7, padding:'8px 10px', boxSizing:'border-box',
                    cursor:wp.tradedDays>0?'pointer':'default',
                    background: isSelWeek
                      ? (wp.pnl>=0?'rgba(59,130,246,.35)':'rgba(239,68,68,.35)')
                      : wp.tradedDays>0
                        ? (wp.pnl>=0?'rgba(59,130,246,.14)':'rgba(239,68,68,.14)')
                        : 'rgba(255,255,255,.02)',
                    border: isSelWeek
                      ? `2px solid ${wp.pnl>=0?'var(--blue)':'var(--red)'}`
                      : wp.tradedDays>0
                        ? calBorder(wp.pnl>=0, 0.5)
                        : '1px solid rgba(255,255,255,.06)',
                    display:'flex', flexDirection:'column', justifyContent:'center', minHeight:0,
                    transition:'all .12s',
                  }}>
                  <div style={{fontSize:9,fontWeight:700,color:'var(--blue-bright)',letterSpacing:'1px',marginBottom:3}}>WEEKLY</div>
                  {wp.tradedDays>0 ? (
                    <>
                      <div style={{fontSize:14,fontWeight:900,color:wp.pnl>=0?'#60a5fa':'#f87171',letterSpacing:'-0.3px',lineHeight:1}}>
                        {fmtShort(wp.pnl)}
                      </div>
                      <div style={{fontSize:10,color:'rgba(255,255,255,.4)',marginTop:3}}>{wp.tradedDays}d traded</div>
                      {(wp.wins+wp.losses)>0 && (
                        <div style={{fontSize:10,fontWeight:700,marginTop:2,
                          color: wp.wins/(wp.wins+wp.losses)>=0.5?'rgba(96,165,250,.85)':'rgba(248,113,113,.85)',
                        }}>
                          {Math.round(wp.wins/(wp.wins+wp.losses)*100)}% WR
                        </div>
                      )}
                      {wp.comm>0 && <div style={{fontSize:9,color:'rgba(239,68,68,.7)',marginTop:1}}>-${wp.comm.toFixed(0)} comm</div>}
                    </>
                  ) : (
                    <div style={{fontSize:11,color:'rgba(255,255,255,.2)'}}>—</div>
                  )}
                </div>
              </div>
            );
          })}
          </div>

          {/* Legend */}
          <div style={{display:'flex',gap:16,marginTop:10,fontSize:11,color:'var(--text-secondary)',flexShrink:0,flexWrap:'wrap'}}>
            <span style={{display:'flex',alignItems:'center',gap:5}}><span style={{width:10,height:10,borderRadius:3,background:'rgba(59,130,246,.4)',display:'inline-block'}}/> Profit day</span>
            <span style={{display:'flex',alignItems:'center',gap:5}}><span style={{width:10,height:10,borderRadius:3,background:'rgba(239,68,68,.4)',display:'inline-block'}}/> Loss day</span>
            <span>💸 Withdrawal</span>
            <span>💰 Deposit</span>
            <span style={{color:'var(--blue-bright)'}}>↗ Click weekly column for breakdown</span>
          </div>
        </div>

        {/* Right panel — Day OR Week detail */}
        <div className="card" style={{ display:'flex', flexDirection:'column', overflow:'auto', height:'100%' }}>

          {/* DAY DETAIL */}
          {detailMode === 'day' && (selCell || selWd) && (
            <>
              <div style={{display:'flex',alignItems:'center',gap:7,marginBottom:14}}>
                <span style={{fontSize:16}}>📅</span>
                <span style={{fontWeight:800,fontSize:15}}>Day Detail</span>
              </div>

              <div style={{marginBottom:12,padding:'10px 12px',background:'var(--bg-hover)',borderRadius:8}}>
                <div style={{fontSize:10,color:'var(--text-muted)',marginBottom:1}}>DATE</div>
                <div style={{fontWeight:700,fontSize:15}}>{fmtDetailDate(selected)}</div>
              </div>

              {selWd && (
                <>
                  {selWd.amount>0 && (
                    <div style={{marginBottom:10,padding:'10px 12px',background:'rgba(245,158,11,.1)',border:'1px solid rgba(245,158,11,.3)',borderRadius:8}}>
                      <div style={{fontSize:10,color:'#f59e0b',fontWeight:700,marginBottom:2}}>💸 WITHDRAWAL</div>
                      <div style={{fontWeight:800,fontSize:18,color:'#f59e0b'}}>-${selWd.amount.toFixed(2)}</div>
                      <div style={{fontSize:10,color:'var(--text-muted)'}}>Not in stats</div>
                    </div>
                  )}
                  {selWd.deposits>0 && (
                    <div style={{marginBottom:10,padding:'10px 12px',background:'rgba(74,222,128,.1)',border:'1px solid rgba(74,222,128,.3)',borderRadius:8}}>
                      <div style={{fontSize:10,color:'#4ade80',fontWeight:700,marginBottom:2}}>💰 DEPOSIT</div>
                      <div style={{fontWeight:800,fontSize:18,color:'#4ade80'}}>+${selWd.deposits.toFixed(2)}</div>
                      <div style={{fontSize:10,color:'var(--text-muted)'}}>Not in stats</div>
                    </div>
                  )}
                </>
              )}

              {selCell && (
                <>
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:10}}>
                    <div style={{padding:'10px 12px',background:selCell.pnl>=0?'rgba(59,130,246,.15)':'rgba(239,68,68,.15)',borderRadius:8}}>
                      <div style={{fontSize:10,color:'var(--text-muted)',marginBottom:2}}>GROSS P&L</div>
                      <div style={{fontWeight:900,fontSize:17,color:selCell.pnl>=0?'#60a5fa':'#f87171'}}>{fmt(selCell.pnl)}</div>
                    </div>
                    <div style={{padding:'10px 12px',background:'rgba(239,68,68,.1)',borderRadius:8}}>
                      <div style={{fontSize:10,color:'var(--text-muted)',marginBottom:2}}>COMMISSION</div>
                      <div style={{fontWeight:900,fontSize:17,color:'#f87171'}}>-${selCell.comm.toFixed(2)}</div>
                    </div>
                  </div>
                  <div style={{marginBottom:12,padding:'12px',background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8,textAlign:'center'}}>
                    <div style={{fontSize:10,color:'var(--text-muted)',marginBottom:4}}>NET P&L</div>
                    <div style={{fontWeight:900,fontSize:22,color:(selCell.pnl-selCell.comm)>=0?'#60a5fa':'#f87171'}}>
                      {fmt(selCell.pnl-selCell.comm)}
                    </div>
                    <div style={{fontSize:11,color:'var(--text-muted)',marginTop:2}}>{selCell.count} trade{selCell.count!==1?'s':''}</div>
                  </div>
                  <div style={{fontSize:11,fontWeight:700,color:'var(--text-muted)',letterSpacing:'.5px',marginBottom:6}}>TRADES</div>
                  {selCell.trades.map(t=>{
                    const comm=tradeComm(t);
                    const net=(t.pnl||0)-comm;
                    return (
                      <div key={t.id} style={{padding:'9px 0',borderBottom:'1px solid var(--border)'}}>
                        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:2}}>
                          <div style={{display:'flex',gap:6,alignItems:'center'}}>
                            <span style={{fontWeight:800,fontSize:13}}>{t.symbol}</span>
                            <span className={`badge badge-${(t.side||'long').toLowerCase()}`} style={{fontSize:9}}>{t.side}</span>
                          </div>
                          <span style={{fontWeight:800,fontSize:13,color:(t.pnl||0)>=0?'#60a5fa':'#f87171'}}>{fmt(t.pnl||0)}</span>
                        </div>
                        <div style={{display:'flex',justifyContent:'space-between',fontSize:10,color:'var(--text-muted)'}}>
                          <span>{t.entryTime}→{t.exitTime||'—'} · {t.size||0} lots</span>
                          {comm>0&&<span style={{color:'rgba(239,68,68,.7)'}}>-${comm.toFixed(2)}</span>}
                        </div>
                        <div style={{fontSize:10,color:net>=0?'rgba(96,165,250,.8)':'rgba(248,113,113,.8)',marginTop:1}}>Net: {fmt(net)}</div>
                      </div>
                    );
                  })}
                </>
              )}
            </>
          )}

          {/* WEEK DETAIL */}
          {detailMode === 'week' && selWeekData && (
            <>
              <div style={{display:'flex',alignItems:'center',gap:7,marginBottom:14}}>
                <span style={{fontSize:16}}>📊</span>
                <span style={{fontWeight:800,fontSize:15}}>Week Breakdown</span>
              </div>

              {/* Week summary cards */}
              <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8,marginBottom:12}}>
                <div style={{padding:'10px 12px',background:selWeekData.pnl>=0?'rgba(59,130,246,.15)':'rgba(239,68,68,.15)',borderRadius:8}}>
                  <div style={{fontSize:10,color:'var(--text-muted)',marginBottom:2}}>GROSS P&L</div>
                  <div style={{fontWeight:900,fontSize:17,color:selWeekData.pnl>=0?'#60a5fa':'#f87171'}}>{fmt(selWeekData.pnl)}</div>
                </div>
                <div style={{padding:'10px 12px',background:'rgba(239,68,68,.1)',borderRadius:8}}>
                  <div style={{fontSize:10,color:'var(--text-muted)',marginBottom:2}}>COMMISSION</div>
                  <div style={{fontWeight:900,fontSize:17,color:'#f87171'}}>-${selWeekData.comm.toFixed(2)}</div>
                </div>
              </div>
              <div style={{marginBottom:12,padding:'12px',background:'var(--bg-card)',border:'1px solid var(--border)',borderRadius:8,textAlign:'center'}}>
                <div style={{fontSize:10,color:'var(--text-muted)',marginBottom:4}}>NET P&L</div>
                <div style={{fontWeight:900,fontSize:22,color:(selWeekData.pnl-selWeekData.comm)>=0?'#60a5fa':'#f87171'}}>
                  {fmt(selWeekData.pnl-selWeekData.comm)}
                </div>
                <div style={{fontSize:11,color:'var(--text-muted)',marginTop:2}}>
                  {weekAllTrades.length} trade{weekAllTrades.length!==1?'s':''} · {selWeekData.tradedDays} day{selWeekData.tradedDays!==1?'s':''}
                </div>
              </div>

              {/* Per-day breakdown */}
              <div style={{fontSize:11,fontWeight:700,color:'var(--text-muted)',letterSpacing:'.5px',marginBottom:6}}>BY DAY</div>
              {selWeekData.days.map(({d, dateStr, cell})=>{
                if (!cell) return null;
                const net=cell.pnl-cell.comm;
                return (
                  <div key={dateStr} style={{padding:'9px 10px',borderRadius:7,marginBottom:5,
                    background:net>=0?'rgba(59,130,246,.08)':'rgba(239,68,68,.08)',
                    border:`1px solid ${net>=0?'rgba(59,130,246,.2)':'rgba(239,68,68,.2)'}`}}>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:3}}>
                      <span style={{fontSize:12,fontWeight:700,color:'var(--text-secondary)'}}>{fmtDetailDate(dateStr)}</span>
                      <span style={{fontSize:13,fontWeight:900,color:net>=0?'#60a5fa':'#f87171'}}>{fmt(net)}</span>
                    </div>
                    <div style={{display:'flex',gap:12,fontSize:10,color:'var(--text-muted)'}}>
                      <span>Gross: {fmt(cell.pnl)}</span>
                      <span>Comm: -${cell.comm.toFixed(2)}</span>
                      <span>{cell.count} trade{cell.count!==1?'s':''}</span>
                    </div>
                  </div>
                );
              })}

              {/* All trades in week */}
              <div style={{fontSize:11,fontWeight:700,color:'var(--text-muted)',letterSpacing:'.5px',margin:'10px 0 6px'}}>ALL TRADES</div>
              {weekAllTrades.map(t=>{
                const comm=tradeComm(t);
                const net=(t.pnl||0)-comm;
                return (
                  <div key={t.id} style={{padding:'8px 0',borderBottom:'1px solid var(--border)'}}>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:2}}>
                      <div style={{display:'flex',gap:6,alignItems:'center'}}>
                        <span style={{fontWeight:800,fontSize:13}}>{t.symbol}</span>
                        <span className={`badge badge-${(t.side||'long').toLowerCase()}`} style={{fontSize:9}}>{t.side}</span>
                        <span style={{fontSize:10,color:'var(--text-muted)'}}>{t.entryDate?.slice(5)}</span>
                      </div>
                      <span style={{fontWeight:800,fontSize:13,color:(t.pnl||0)>=0?'#60a5fa':'#f87171'}}>{fmt(t.pnl||0)}</span>
                    </div>
                    <div style={{display:'flex',justifyContent:'space-between',fontSize:10,color:'var(--text-muted)'}}>
                      <span>{t.entryTime}→{t.exitTime||'—'} · {t.size||0} lots</span>
                      {comm>0&&<span style={{color:'rgba(239,68,68,.7)'}}>comm -${comm.toFixed(2)}</span>}
                    </div>
                    <div style={{fontSize:10,color:net>=0?'rgba(96,165,250,.8)':'rgba(248,113,113,.8)',marginTop:1}}>Net: {fmt(net)}</div>
                  </div>
                );
              })}
            </>
          )}

          {/* Empty state */}
          {!(selCell||selWd) && !(detailMode==='week'&&selWeekData) && (
            <div style={{textAlign:'center',padding:'40px 16px',color:'var(--text-muted)',display:'flex',flexDirection:'column',alignItems:'center',justifyContent:'center',height:'100%'}}>
              <div style={{fontSize:36,marginBottom:14}}>📅</div>
              <div style={{fontSize:14,fontWeight:600,marginBottom:6}}>No selection</div>
              <div style={{fontSize:12,lineHeight:1.6}}>Click a day cell to see trade details, or click the weekly column to see the full week breakdown</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
