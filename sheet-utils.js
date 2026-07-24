/* ======================= SHEET CONNECTION UTILITIES ======================= */
/* Shared by index.html, estimator.html, and issues.html */

function extractSheetId(url){
  const m = url.match(/\/d\/([a-zA-Z0-9-_]+)/);
  if(m) return m[1];
  if(/^[a-zA-Z0-9-_]{20,}$/.test(url.trim())) return url.trim();
  return null;
}

function tabUrl(sheetId, tabName){
  return `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&sheet=${encodeURIComponent(tabName)}`;
}

// Minimal RFC4180 CSV parser (handles quoted fields with commas/newlines)
function parseCSV(text){
  const rows = []; let row = []; let field = ""; let inQuotes = false;
  for(let i=0; i<text.length; i++){
    const c = text[i];
    if(inQuotes){
      if(c === '"'){
        if(text[i+1] === '"'){ field += '"'; i++; } else { inQuotes = false; }
      } else { field += c; }
    } else {
      if(c === '"'){ inQuotes = true; }
      else if(c === ','){ row.push(field); field = ""; }
      else if(c === '\n'){ row.push(field); rows.push(row); row = []; field = ""; }
      else if(c === '\r'){ /* skip */ }
      else { field += c; }
    }
  }
  if(field.length || row.length){ row.push(field); rows.push(row); }
  return rows;
}

async function fetchTabCSV(sheetId, tabName){
  const url = tabUrl(sheetId, tabName);
  let resp;
  try{ resp = await fetch(url); }
  catch(networkErr){ const e = new Error("network"); e.reason = "network"; throw e; }
  const text = await resp.text();
  if(!resp.ok){ const e = new Error("http_"+resp.status); e.reason = "http"; e.status = resp.status; throw e; }
  if(text.trim().startsWith("<")){ const e = new Error("html_response"); e.reason = "html"; throw e; }
  const rows = parseCSV(text);
  if(rows.length < 1){ const e = new Error("empty"); e.reason = "empty"; throw e; }
  return rows;
}

/* ======================= VALUE HELPERS ======================= */

function numOf(v){
  if(v===null||v===undefined||v==="") return null;
  const n = parseFloat(String(v).replace(/[,%\s]/g,""));
  return isNaN(n) ? null : n;
}
// Handles "73%", "0.73", or "73" (bare number meaning 73%) -> returns 0.73
function pctOf(v){
  if(v===null||v===undefined||v==="") return null;
  const s = String(v).trim();
  if(s.endsWith('%')) { const n=parseFloat(s); return isNaN(n)?null:n/100; }
  const n = parseFloat(s.replace(/,/g,""));
  if(isNaN(n)) return null;
  return Math.abs(n) > 1.5 ? n/100 : n;
}

// label -> value map built from two adjacent columns (default A/B)
function buildLabelMap(rows, labelCol=0, valueCol=1){
  const map = {};
  rows.forEach(row=>{
    const label = row[labelCol];
    if(label && String(label).trim()){
      const key = String(label).trim();
      if(!(key in map)) map[key] = (row[valueCol] !== undefined && row[valueCol] !== "") ? row[valueCol] : null;
    }
  });
  return map;
}
function fromMap(map, ...keys){
  for(const k of keys){ if(map[k] !== undefined && map[k] !== null) return map[k]; }
  return null;
}

/* ======================= MASTER LIST PARSING ======================= */

const MASTER_LIST_TAB = "Site Master List Backend";

async function fetchMasterList(sheetId){
  const rows = await fetchTabCSV(sheetId, MASTER_LIST_TAB);
  const header = rows[0].map(h => String(h||"").trim().toLowerCase());
  const idx = (name) => header.findIndex(h => h === name.toLowerCase());
  const cSite = idx("site number");
  const cClient = idx("client name");
  const cAddr = idx("client address");
  const cSize = idx("size (kw-dc)");
  const cInv = idx("inverter");
  const cAct = idx("system activation date");
  const cEstY1 = idx("est. y1 output (kwh)");

  const list = [];
  for(let r=1; r<rows.length; r++){
    const row = rows[r];
    const siteNum = cSite>=0 ? row[cSite] : null;
    if(!siteNum || !String(siteNum).trim()) continue;
    list.push({
      site_number: String(siteNum).trim(),
      client_name: cClient>=0 ? row[cClient] : null,
      address: cAddr>=0 ? row[cAddr] : null,
      capacity_kw: cSize>=0 ? numOf(row[cSize]) : null,
      inverter: cInv>=0 ? row[cInv] : null,
      activation: cAct>=0 ? row[cAct] : null,
      est_y1_output: cEstY1>=0 ? numOf(row[cEstY1]) : null,
    });
  }
  return list;
}

/* ======================= SITE TAB PARSING (robust: label + dynamic header) ======================= */

function parseSiteTab(rows){
  const labelMap = buildLabelMap(rows, 0, 1);
  const meta = {
    site_number: fromMap(labelMap, "Site Number"),
    client_name: fromMap(labelMap, "Client Name"),
    address: fromMap(labelMap, "Client Address"),
    capacity_kw: numOf(fromMap(labelMap, "Size (kW-DC)")),
    inverter: fromMap(labelMap, "Inverter"),
    activation: fromMap(labelMap, "System Activation Date"),
    est_y1_output: numOf(fromMap(labelMap, "Est. Y1 Output (kWh)")),
    monitoring_link: fromMap(labelMap, "Monitoring Link"),
    ytd_actual_kwh: numOf(fromMap(labelMap, "YTD Actual Production (kWh)")) || 0,
    ytd_estimate_kwh: numOf(fromMap(labelMap, "YTD Estimated Production (kWh)")) || 0,
    ytd_pct: pctOf(fromMap(labelMap, "YTD % of Estimate", "YTD % of Estimate ")) || 0,
  };

  // ---- Annual Summary table: locate header row/col where "Year" is followed by "ProductionYear" ----
  let annual = [];
  outerAnnual:
  for(let r=0; r<rows.length; r++){
    const row = rows[r];
    for(let c=0; c<row.length-1; c++){
      if(String(row[c]||"").trim()==="Year" && String(row[c+1]||"").trim()==="ProductionYear"){
        for(let rr=r+1; rr<rows.length; rr++){
          const yr = rows[rr][c];
          if(!yr || !String(yr).trim().startsWith("Year")) break;
          annual.push({
            year: String(yr).trim(),
            calendar_year: numOf(rows[rr][c+1]),
            actual_mwh: numOf(rows[rr][c+2]) || 0,
            estimate_mwh: numOf(rows[rr][c+3]) || 0,
            pct: pctOf(rows[rr][c+4]) || 0,
          });
        }
        break outerAnnual;
      }
    }
  }

  // ---- Monthly Production table: locate header row/col where "Year","Month","Year Month" appear in sequence ----
  let monthly = [];
  outerMonthly:
  for(let r=0; r<rows.length; r++){
    const row = rows[r];
    for(let c=0; c<row.length-2; c++){
      if(String(row[c]||"").trim()==="Year" &&
         String(row[c+1]||"").trim()==="Month" &&
         String(row[c+2]||"").trim().toLowerCase().includes("year month")){
        let idxCO2=-1, idxHomes=-1, idxCarbon=-1;
        for(let cc=c; cc<row.length; cc++){
          const label = String(row[cc]||"").trim().toLowerCase();
          if(label.includes("co2")) idxCO2=cc;
          else if(label.includes("homes")) idxHomes=cc;
          else if(label.includes("carbon")) idxCarbon=cc;
        }
        for(let rr=r+1; rr<rows.length; rr++){
          const yr = rows[rr][c];
          const dateStr = rows[rr][c+2];
          if(!dateStr || String(dateStr).trim()===""){
            if(!yr || String(yr).trim()==="") break; else continue;
          }
          monthly.push({
            year: yr ? String(yr).trim() : null,
            month: rows[rr][c+1],
            date: dateStr,
            actual_kwh: numOf(rows[rr][c+3]) || 0,
            estimate_kwh: numOf(rows[rr][c+4]) || 0,
            pct: pctOf(rows[rr][c+5]) || 0,
            status: rows[rr][c+6],
            co2: idxCO2>=0 ? (numOf(rows[rr][idxCO2])||0) : 0,
            homes: idxHomes>=0 ? (numOf(rows[rr][idxHomes])||0) : 0,
            carbon: idxCarbon>=0 ? (numOf(rows[rr][idxCarbon])||0) : 0,
          });
        }
        break outerMonthly;
      }
    }
  }

  let data_status;
  if(typeof meta.inverter === "string" && meta.inverter.trim().toLowerCase()==="inactive") data_status = "inactive";
  else if(monthly.length > 0) data_status = "synced";
  else data_status = "pending";

  return { ...meta, data_status, annual, monthly };
}

/* ======================= FULL PORTFOLIO LOAD ======================= */
// Loads the Master List, then every listed site tab, merging Master List meta (authoritative)
// over each site tab's own meta. Reports progress via onProgress(loadedCount, total, siteNumber).
async function loadFullPortfolio(sheetId, onProgress){
  const masterList = await fetchMasterList(sheetId);
  const sites = [];
  for(let i=0; i<masterList.length; i++){
    const m = masterList[i];
    try{
      const rows = await fetchTabCSV(sheetId, m.site_number);
      const tab = parseSiteTab(rows);
      sites.push({
        site_number: m.site_number,
        client_name: m.client_name || tab.client_name,
        address: m.address || tab.address,
        capacity_kw: m.capacity_kw !== null ? m.capacity_kw : tab.capacity_kw,
        inverter: m.inverter || tab.inverter,
        activation: m.activation || tab.activation,
        est_y1_output: m.est_y1_output !== null ? m.est_y1_output : tab.est_y1_output,
        monitoring_link: tab.monitoring_link,
        ytd_actual_kwh: tab.ytd_actual_kwh,
        ytd_estimate_kwh: tab.ytd_estimate_kwh,
        ytd_pct: tab.ytd_pct,
        data_status: tab.data_status,
        annual: tab.annual,
        monthly: tab.monthly,
      });
    } catch(e){
      // Site listed in Master List but its own tab couldn't be read — still include with Master List meta only
      sites.push({
        site_number: m.site_number, client_name: m.client_name, address: m.address,
        capacity_kw: m.capacity_kw, inverter: m.inverter, activation: m.activation,
        est_y1_output: m.est_y1_output, monitoring_link: null,
        ytd_actual_kwh: 0, ytd_estimate_kwh: 0, ytd_pct: 0,
        data_status: "pending", annual: [], monthly: [],
      });
    }
    if(onProgress) onProgress(i+1, masterList.length, m.site_number);
  }
  return sites;
}

function getSheetParamFromUrl(){
  const params = new URLSearchParams(window.location.search);
  return params.get("sheet");
}
