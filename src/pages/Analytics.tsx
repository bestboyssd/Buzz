import React, { useMemo, useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'motion/react';
import {
  formatPrice,
  useOptimizedTransition,
  useHardwareAcceleration,
  getAppBusinessDate,
  getAppBusinessIsoDate,
} from '../lib/utils';
import {
  ArrowLeft,
  Sparkles,
  ShoppingBag,
  Flame,
  AlertTriangle,
  Copy,
  Check,
  Zap,
  Send,
  RefreshCw,
  ArrowUpRight,
  RotateCcw,
  BarChart3,
  Clock,
  FileText,
  Printer,
  Tag,
  X,
  Users,
} from 'lucide-react';
import { useGlobalBills } from '../lib/BillsContext';
import { useGlobalProducts } from '../lib/ProductsContext';
import { useAuth } from '../lib/AuthContext';
import { useNavigate, Navigate } from 'react-router-dom';
import { AreaChart, Area, BarChart, Bar, XAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { triggerHaptic } from '../lib/haptics';
import { db } from '../lib/firebase';
import { collection, doc, onSnapshot } from 'firebase/firestore';
import { askGeminiAssistantStream, StoreContext } from '../lib/geminiApi';
import { getImageUrl } from '../lib/imageUtils';
import { ProductImagePlaceholder } from '../components/ProductImagePlaceholder';
import { getEffectiveProductCost } from '../lib/firestoreHooks';
import {
  sendEscPosZReportToConnectedPrinter,
  getPrinterState,
  subscribePrinterState,
  connectRealPrinter,
  PrinterState,
} from '../lib/printerManager';

function triggerIsolatedZReportPrint(zReportData: any): boolean {
  try {
    const existingFrame = document.getElementById('smartpos-zreport-print-iframe') as HTMLIFrameElement | null;
    if (existingFrame && existingFrame.parentNode) {
      existingFrame.parentNode.removeChild(existingFrame);
    }

    const iframe = document.createElement('iframe');
    iframe.id = 'smartpos-zreport-print-iframe';
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '1px';
    iframe.style.height = '1px';
    iframe.style.border = '0';
    iframe.style.opacity = '0.01';
    iframe.style.pointerEvents = 'none';
    document.body.appendChild(iframe);

    const escapeHtml = (str: any) =>
      String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');

    const fmtSigned = (val: number) => {
      const n = Number(val) || 0;
      if (n < 0) return `-₹${formatPrice(Math.abs(n))}`;
      if (n > 0) return `+₹${formatPrice(n)}`;
      return `₹${formatPrice(0)}`;
    };

    const itemsRows = (Array.isArray(zReportData.soldItems) ? zReportData.soldItems : [])
      .map(
        (it: any) => `
        <tr>
          <td class="name">
            <div>${escapeHtml(it.name)}</div>
            <div class="sub">Sell ₹${formatPrice(it.unitSellPrice || 0)} · ${
              Number(it.unitBuyCost) > 0
                ? `Buy ₹${formatPrice(it.unitBuyCost)}`
                : 'No buy price'
            }</div>
          </td>
          <td class="qty">${Number(it.qty) || 0}×</td>
          <td class="amt">
            <div>₹${formatPrice(it.revenue || 0)}</div>
            <div class="sub">${
              Number(it.unitBuyCost) > 0 ? fmtSigned(it.profit || 0) : '₹0 profit'
            }</div>
          </td>
        </tr>`
      )
      .join('');

    const cashierRows = (Array.isArray(zReportData.cashiers) ? zReportData.cashiers : [])
      .map(
        (c: any) => `
        <div class="row">
          <span>${escapeHtml(c.name)} (${Number(c.bills) || 0} bills)</span>
          <strong>₹${formatPrice(c.sales || 0)}</strong>
        </div>`
      )
      .join('');

    const expenseRows = (Array.isArray(zReportData.dayOutlayItems) ? zReportData.dayOutlayItems : [])
      .map(
        (exp: any) => `
        <div class="row">
          <span>${escapeHtml(exp.title)} (${escapeHtml(exp.category)})</span>
          <strong>-₹${formatPrice(exp.amount || 0)}</strong>
        </div>`
      )
      .join('');

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Z-Report - ${escapeHtml(zReportData.dateLabel)}</title>
  <style>
    @page {
      size: 80mm auto;
      margin: 3mm;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
    }
    body {
      font-family: 'JetBrains Mono', 'Courier New', Courier, monospace;
      background: #ffffff;
      color: #000000;
      width: 100%;
      max-width: 76mm;
      margin: 0 auto;
      padding: 6px 4px 16px;
      font-size: 12px;
      line-height: 1.4;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .header {
      text-align: center;
      padding-bottom: 8px;
      border-bottom: 1px dashed #000;
      margin-bottom: 8px;
    }
    .brand {
      font-size: 16px;
      font-weight: 800;
    }
    .date {
      font-size: 12px;
      font-weight: 700;
      margin-top: 2px;
    }
    .sub {
      font-size: 10px;
      color: #333;
    }
    .section {
      padding-bottom: 8px;
      border-bottom: 1px dashed #000;
      margin-bottom: 8px;
    }
    .section-title {
      font-size: 10px;
      font-weight: 800;
      text-transform: uppercase;
      margin-bottom: 4px;
    }
    .row {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      margin-bottom: 3px;
    }
    .highlight {
      display: flex;
      justify-content: space-between;
      font-size: 13px;
      font-weight: 800;
      border-top: 1px solid #000;
      padding-top: 5px;
      margin-top: 4px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
    }
    th {
      font-size: 10px;
      text-transform: uppercase;
      border-bottom: 1px dashed #000;
      padding-bottom: 3px;
      text-align: left;
    }
    th.qty { text-align: center; width: 34px; }
    th.amt { text-align: right; width: 70px; }
    td {
      padding: 4px 0;
      vertical-align: top;
      border-bottom: 1px dotted #ccc;
      font-size: 11px;
    }
    td.name { font-weight: 600; padding-right: 4px; }
    td.qty { text-align: center; font-weight: 600; }
    td.amt { text-align: right; font-weight: 700; white-space: nowrap; }
    .footer {
      text-align: center;
      font-size: 10px;
      margin-top: 10px;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="brand">DAILY Z-REPORT</div>
    <div class="date">${escapeHtml(zReportData.dateLabel)}</div>
    <div class="sub">${zReportData.completedBillsCount > 0 ? `${escapeHtml(zReportData.firstBillTime)} – ${escapeHtml(zReportData.lastBillTime)}` : 'No completed bills'}</div>
  </div>

  <div class="section">
    <div class="row"><span>Total Sales (${zReportData.completedBillsCount} bills)</span><strong>₹${formatPrice(zReportData.grossSales || 0)}</strong></div>
    <div class="row"><span>Items Sold</span><span>${zReportData.totalUnitsSold || 0} items</span></div>
    <div class="row"><span>Avg Bill</span><span>₹${formatPrice(zReportData.avgBillValue || 0)}</span></div>
    <div class="row"><span>Item Buy Price</span><span>-₹${formatPrice(zReportData.shiftCogs || 0)}</span></div>
    <div class="row"><span>Shop Expenses (${(zReportData.dayOutlayItems || []).length})</span><span>-₹${formatPrice(zReportData.dayOtherCosts || 0)}</span></div>
    ${zReportData.totalDiscount > 0 ? `<div class="row"><span>Discounts</span><span>-₹${formatPrice(zReportData.totalDiscount)}</span></div>` : ''}
    <div class="highlight">
      <span>${(zReportData.netShiftProfit || 0) >= 0 ? 'FINAL PROFIT' : 'NET LOSS'}</span>
      <span>${fmtSigned(zReportData.netShiftProfit || 0)}</span>
    </div>
    <div class="highlight">
      <span>CASH IN DRAWER</span>
      <span>₹${formatPrice(zReportData.expectedCashInDrawer || 0)}</span>
    </div>
  </div>

  ${
    zReportData.udharBillsCount > 0 || zReportData.heldBillsCount > 0
      ? `<div class="section">
          <div class="section-title">Pending Bills</div>
          ${zReportData.udharBillsCount > 0 ? `<div class="row"><span>Unpaid Udhar (${zReportData.udharBillsCount})</span><strong>₹${formatPrice(zReportData.udharBillsTotal || 0)}</strong></div>` : ''}
          ${zReportData.heldBillsCount > 0 ? `<div class="row"><span>On Hold (${zReportData.heldBillsCount})</span><strong>₹${formatPrice(zReportData.heldBillsTotal || 0)}</strong></div>` : ''}
        </div>`
      : ''
  }

  ${
    itemsRows
      ? `<div class="section">
          <div class="section-title">Items Sold (${(zReportData.soldItems || []).length})</div>
          <table>
            <thead>
              <tr><th>Item</th><th class="qty">Qty</th><th class="amt">Sales</th></tr>
            </thead>
            <tbody>${itemsRows}</tbody>
          </table>
        </div>`
      : ''
  }

  ${
    cashierRows
      ? `<div class="section">
          <div class="section-title">Staff Summary</div>
          ${cashierRows}
        </div>`
      : ''
  }

  ${
    expenseRows
      ? `<div class="section">
          <div class="section-title">Shop Expenses</div>
          ${expenseRows}
        </div>`
      : ''
  }

  <div class="footer">Printed on ${new Date().toLocaleString()}</div>
</body>
</html>`;

    const androidBridge = typeof window !== 'undefined' ? (window as any).AndroidExporter : null;
    if (androidBridge && typeof androidBridge.printHtml === 'function') {
      try {
        if (iframe.parentNode) {
          iframe.parentNode.removeChild(iframe);
        }
        return Boolean(
          androidBridge.printHtml(
            `Z_Report_${String(zReportData.dateLabel || 'Today').replace(/\s+/g, '_')}`,
            html
          )
        );
      } catch (e) {
        console.warn('Android native print bridge fallback:', e);
      }
    }

    const docRef = iframe.contentWindow?.document || iframe.contentDocument;
    if (!docRef || !iframe.contentWindow) {
      window.print();
      return true;
    }

    docRef.open();
    docRef.write(html);
    docRef.close();

    try {
      iframe.contentWindow.focus();
      iframe.contentWindow.print();
    } catch {
      try {
        window.print();
      } catch {}
    }
    return true;
  } catch (err) {
    console.warn('Z-Report iframe print fallback:', err);
    try {
      window.print();
      return true;
    } catch {
      return false;
    }
  }
}

type TimeframeTab = '30days' | 'year';
type AiFeatureTab = 'buy_next' | 'velocity' | 'patterns' | 'advisor';

export function Analytics() {
  const { isAdmin: isUserAdmin, isRealAdmin } = useAuth();
  const isAdmin = isRealAdmin || isUserAdmin || sessionStorage.getItem('adminAuth') === 'true';
  const { bills } = useGlobalBills();
  const { products } = useGlobalProducts();
  const navigate = useNavigate();
  const chartContainerRef = useRef<HTMLDivElement | null>(null);
  const [chartReadyWidth, setChartReadyWidth] = useState<number>(0);

  useEffect(() => {
    if (isRealAdmin || isUserAdmin) {
      sessionStorage.setItem('adminAuth', 'true');
    }
  }, [isRealAdmin, isUserAdmin]);

  const [activeTab, setActiveTab] = useState<TimeframeTab>('30days');
  const [aiTab, setAiTab] = useState<AiFeatureTab>('buy_next');
  const [otherCostsList, setOtherCostsList] = useState<any[]>(() => {
    try {
      const cached = localStorage.getItem('local_other_costs_fallback');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {}
    return [];
  });
  const [otherCostsAmount, setOtherCostsAmount] = useState<number>(() => {
    try {
      const cached = localStorage.getItem('local_other_costs_fallback');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed)) {
          return parsed.reduce((acc, c) => acc + (Number(c?.amount) || 0), 0);
        }
      }
    } catch {}
    return 0;
  });
  const [copiedShoppingList, setCopiedShoppingList] = useState(false);
  const [copiedAiAdvice, setCopiedAiAdvice] = useState(false);

  // End-of-Day Shift Closing Summary (Z-Report) State (1:00 AM business day cutoff)
  const [isZReportOpen, setIsZReportOpen] = useState(false);
  const [zReportDatePreset, setZReportDatePreset] = useState<'today' | 'yesterday' | 'custom'>('today');
  const [zReportCustomDate, setZReportCustomDate] = useState<string>(() => getAppBusinessIsoDate());
  const [zReportSectionTab, setZReportSectionTab] = useState<'items' | 'cashiers' | 'outlays'>('items');
  const [showAllZItems, setShowAllZItems] = useState(false);
  const [copiedZReport, setCopiedZReport] = useState(false);
  const [printingZReport, setPrintingZReport] = useState(false);
  const [zReportPrinterAlert, setZReportPrinterAlert] = useState(false);
  const [printerState, setPrinterState] = useState<PrinterState>(() => getPrinterState());
  const [zReportDragY, setZReportDragY] = useState(0);
  const zReportDragStartYRef = useRef<number | null>(null);

  useEffect(() => {
    return subscribePrinterState((state) => {
      setPrinterState(state);
      if (state.connected) {
        setZReportPrinterAlert(false);
      }
    });
  }, []);
  const [savedZReportsList, setSavedZReportsList] = useState<any[]>(() => {
    try {
      const cached = localStorage.getItem('local_z_reports_fallback');
      if (cached) {
        const parsed = JSON.parse(cached);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {}
    return [];
  });

  // Live Gemini AI Advisor State
  const [aiPrompt, setAiPrompt] = useState('');
  const [aiResponse, setAiResponse] = useState('');
  const [aiLoading, setAiLoading] = useState(false);
  const [activePromptLabel, setActivePromptLabel] = useState('');

  const timeframeTrackRef = useRef<HTMLDivElement | null>(null);
  const aiTrackRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = chartContainerRef.current;
    if (!el) return;

    const updateDimensions = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setChartReadyWidth((prev) => {
          const next = Math.floor(rect.width);
          return prev === next ? prev : next;
        });
      }
    };

    updateDimensions();
    const rafId = requestAnimationFrame(updateDimensions);

    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      observer = new ResizeObserver((entries) => {
        for (const entry of entries) {
          const width = entry.contentRect.width;
          if (width > 0) {
            setChartReadyWidth((prev) => {
              const next = Math.floor(width);
              return prev === next ? prev : next;
            });
          }
        }
      });
      observer.observe(el);
    } else {
      window.addEventListener('resize', updateDimensions);
    }

    return () => {
      cancelAnimationFrame(rafId);
      if (observer) {
        observer.disconnect();
      } else {
        window.removeEventListener('resize', updateDimensions);
      }
    };
  }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin) return;
    const unsubscribe = onSnapshot(
      collection(db, 'other_costs'),
      (snapshot) => {
        if (snapshot.empty) {
          try {
            const cached = localStorage.getItem('local_other_costs_fallback');
            if (cached) {
              const parsed = JSON.parse(cached);
              if (Array.isArray(parsed) && parsed.length > 0) {
                const cachedSum = parsed.reduce((acc, c) => acc + (Number(c?.amount) || 0), 0);
                setOtherCostsList(parsed);
                setOtherCostsAmount(cachedSum);
                return;
              }
            }
          } catch {}
        }
        let sum = 0;
        const list: any[] = [];
        snapshot.forEach((docSnap) => {
          const data = docSnap.data();
          sum += Number(data.amount) || 0;
          list.push({ id: docSnap.id, ...data });
        });
        setOtherCostsAmount(sum);
        setOtherCostsList(list);
        try {
          localStorage.setItem('local_other_costs_fallback', JSON.stringify(list));
        } catch {}
      },
      (err) => {
        console.warn('Analytics cost reading failed', err);
      }
    );

    const unsubZReports = onSnapshot(
      doc(db, 'settings', 'z_reports_snapshot'),
      (snap) => {
        if (!snap.exists()) return;
        const data = snap.data();
        if (Array.isArray(data?.reports) && data.reports.length > 0) {
          setSavedZReportsList(data.reports);
          try {
            localStorage.setItem('local_z_reports_fallback', JSON.stringify(data.reports));
          } catch {}
        }
      },
      () => {}
    );

    const handleLocalUpdate = (e: Event) => {
      const custom = e as CustomEvent<any[]>;
      if (Array.isArray(custom.detail)) {
        const list = custom.detail;
        const sum = list.reduce((acc, c) => acc + (Number(c?.amount) || 0), 0);
        setOtherCostsList(list);
        setOtherCostsAmount(sum);
      }
    };

    const handleZReportsUpdate = (e: Event) => {
      const custom = e as CustomEvent<any[]>;
      if (Array.isArray(custom.detail)) {
        setSavedZReportsList(custom.detail);
      }
    };

    window.addEventListener('otherCostsUpdated', handleLocalUpdate);
    window.addEventListener('localOtherCostsUpdated', handleLocalUpdate);
    window.addEventListener('zReportsUpdated', handleZReportsUpdate);
    return () => {
      unsubscribe();
      unsubZReports();
      window.removeEventListener('otherCostsUpdated', handleLocalUpdate);
      window.removeEventListener('localOtherCostsUpdated', handleLocalUpdate);
      window.removeEventListener('zReportsUpdated', handleZReportsUpdate);
    };
  }, [isAdmin]);

  // Fast product lookup maps for cost resolution across historical bills
  const productLookup = useMemo(() => {
    const byId = new Map<string, any>();
    const byName = new Map<string, any>();
    products.forEach((p) => {
      if (p.id) byId.set(String(p.id).toLowerCase().trim(), p);
      if (p.name) byName.set(String(p.name).toLowerCase().trim(), p);
    });
    return { byId, byName };
  }, [products]);

  const resolveItemUnitCost = (item: any, billTimestamp: number): number => {
    if (
      item?.costPrice !== undefined &&
      item?.costPrice !== null &&
      !Number.isNaN(Number(item.costPrice)) &&
      Number(item.costPrice) > 0
    ) {
      return Math.max(0, Number(item.costPrice));
    }
    const idKey = String(item?.productId || '').toLowerCase().trim();
    const nameKey = String(item?.name || '').toLowerCase().trim();
    const matchedProd = productLookup.byId.get(idKey) || productLookup.byName.get(nameKey);
    if (!matchedProd) {
      return getEffectiveProductCost({ id: item?.productId, name: item?.name }, billTimestamp);
    }
    return getEffectiveProductCost(matchedProd, billTimestamp);
  };

  const { chartData, totalAmount, totalCogs, grossProductProfit } = useMemo(() => {
    type ChartPoint = { name: string; total: number; profit: number; timestamp?: number; month?: number; year?: number };
    if (activeTab === '30days') {
      const data: ChartPoint[] = [];
      // Until 1:00 AM, count as today across the app
      const today = getAppBusinessDate();
      today.setHours(0, 0, 0, 0);

      for (let i = 29; i >= 0; i--) {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        data.push({
          name: d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
          timestamp: d.getTime(),
          total: 0,
          profit: 0,
        });
      }

      let cogsSum = 0;
      let profitSum = 0;
      bills.forEach((bill) => {
        if (bill.status === 'on_hold' || (bill as any).status === 'on_udhar') return;
        // Bills use 12:00 AM midnight cutoff because billing stops around 11:30 PM
        const billDate = new Date(bill.date);
        billDate.setHours(0, 0, 0, 0);

        const point = data.find((d) => d.timestamp === billDate.getTime());
        if (point) {
          const billTotal = Number(bill.total) || 0;
          const billDiscount = Math.max(0, Number((bill as any).discount) || 0);
          point.total += billTotal;
          const billTs = new Date(bill.date).getTime();
          const items = Array.isArray(bill.items) ? bill.items : [];
          let billCogs = 0;
          let billProfit = 0;
          items.forEach((item: any) => {
            const qty = Math.max(1, Number(item.quantity) || 1);
            const sellPrice = Math.max(0, Number(item.price) || 0);
            const unitCost = resolveItemUnitCost(item, billTs);
            // If buy price is NOT set (unitCost <= 0), do not add this item to profit at all (only revenue)
            if (unitCost > 0) {
              const itemCogs = unitCost * qty;
              const itemProfit = (sellPrice - unitCost) * qty;
              billCogs += itemCogs;
              billProfit += itemProfit;
            }
          });
          if (billDiscount > 0 && billProfit > 0) {
            billProfit -= billDiscount;
          }
          cogsSum += billCogs;
          profitSum += billProfit;
          point.profit += billProfit;
        }
      });

      const grossSales = data.reduce((sum, d) => sum + d.total, 0);
      return {
        chartData: data,
        totalAmount: grossSales,
        totalCogs: cogsSum,
        grossProductProfit: profitSum,
      };
    } else {
      const data: ChartPoint[] = [];
      const today = getAppBusinessDate();

      for (let i = 11; i >= 0; i--) {
        const d = new Date(today.getFullYear(), today.getMonth() - i, 1);
        data.push({
          name: d.toLocaleDateString(undefined, { month: 'short' }),
          month: d.getMonth(),
          year: d.getFullYear(),
          total: 0,
          profit: 0,
        });
      }

      let cogsSum = 0;
      let profitSum = 0;
      bills.forEach((bill) => {
        if (bill.status === 'on_hold' || (bill as any).status === 'on_udhar') return;
        const billDate = new Date(bill.date);
        const point = data.find(
          (d) => d.month === billDate.getMonth() && d.year === billDate.getFullYear()
        );
        if (point) {
          const billTotal = Number(bill.total) || 0;
          const billDiscount = Math.max(0, Number((bill as any).discount) || 0);
          point.total += billTotal;
          const billTs = new Date(bill.date).getTime();
          const items = Array.isArray(bill.items) ? bill.items : [];
          let billCogs = 0;
          let billProfit = 0;
          items.forEach((item: any) => {
            const qty = Math.max(1, Number(item.quantity) || 1);
            const sellPrice = Math.max(0, Number(item.price) || 0);
            const unitCost = resolveItemUnitCost(item, billTs);
            // If buy price is NOT set (unitCost <= 0), do not add this item to profit at all (only revenue)
            if (unitCost > 0) {
              const itemCogs = unitCost * qty;
              const itemProfit = (sellPrice - unitCost) * qty;
              billCogs += itemCogs;
              billProfit += itemProfit;
            }
          });
          if (billDiscount > 0 && billProfit > 0) {
            billProfit -= billDiscount;
          }
          cogsSum += billCogs;
          profitSum += billProfit;
          point.profit += billProfit;
        }
      });

      const grossSales = data.reduce((sum, d) => sum + d.total, 0);
      return {
        chartData: data,
        totalAmount: grossSales,
        totalCogs: cogsSum,
        grossProductProfit: profitSum,
      };
    }
  }, [bills, activeTab, productLookup]);

  // Catalog Cost Configuration Stats (Only shown in Analytics)
  const costConfigSummary = useMemo(() => {
    let configuredCount = 0;
    products.forEach((p) => {
      const activeCost = getEffectiveProductCost(p);
      if (activeCost > 0) configuredCount += 1;
    });
    return {
      configuredCount,
      totalProducts: products.length,
    };
  }, [products]);

  // ============================================================================
  // END-OF-DAY SHIFT CLOSING SUMMARY (Z-REPORT) ENGINE
  // - App-wide "Today" stays active until 1:00 AM (since shop sometimes closes at 12:00 AM).
  // - Bills use 12:00 AM midnight cutoff (since billing stops ~11:30 PM).
  // - Shift expenses/outlays count up to 1:00 AM for that shift day.
  // ============================================================================
  const zReportData = useMemo(() => {
    const targetDay = getAppBusinessDate();
    if (zReportDatePreset === 'yesterday') {
      targetDay.setDate(targetDay.getDate() - 1);
    } else if (zReportDatePreset === 'custom' && zReportCustomDate) {
      const [y, m, d] = zReportCustomDate.split('-').map(Number);
      if (y && m && d) {
        targetDay.setFullYear(y, m - 1, d);
      }
    }

    // Bills window: 12:00 AM midnight to 11:59:59.999 PM (billing stops ~11:30 PM)
    const billDayStart = new Date(
      targetDay.getFullYear(),
      targetDay.getMonth(),
      targetDay.getDate(),
      0,
      0,
      0,
      0
    ).getTime();
    const billDayEnd = new Date(
      targetDay.getFullYear(),
      targetDay.getMonth(),
      targetDay.getDate(),
      23,
      59,
      59,
      999
    ).getTime();

    // App/Shift window for expenses: extends until 1:00 AM after midnight closing
    const targetIsoDate = `${targetDay.getFullYear()}-${String(targetDay.getMonth() + 1).padStart(2, '0')}-${String(targetDay.getDate()).padStart(2, '0')}`;

    const dateLabel = targetDay.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });

    const completedBills: any[] = [];
    const heldBills: any[] = [];
    const udharBills: any[] = [];

    bills.forEach((b) => {
      const ts = new Date(b.date).getTime();
      if (ts >= billDayStart && ts <= billDayEnd) {
        if (b.status === 'on_hold') {
          heldBills.push(b);
        } else if (b.isUdhar || (b as any).status === 'on_udhar') {
          udharBills.push(b);
        } else {
          completedBills.push(b);
        }
      }
    });

    let grossSales = 0;
    let totalDiscount = 0;
    let totalUnitsSold = 0;
    let shiftCogs = 0;
    let grossProductProfitDay = 0;
    let firstBillTs: number | null = null;
    let lastBillTs: number | null = null;

    const cashierMap: Record<string, { name: string; bills: number; sales: number; profit: number }> = {};
    const itemSoldMap: Record<
      string,
      {
        name: string;
        qty: number;
        pricedQty: number;
        unitSellPrice: number;
        unitBuyCost: number;
        revenue: number;
        cogs: number;
        profit: number;
      }
    > = {};

    completedBills.forEach((bill) => {
      const ts = new Date(bill.date).getTime();
      if (firstBillTs === null || ts < firstBillTs) firstBillTs = ts;
      if (lastBillTs === null || ts > lastBillTs) lastBillTs = ts;

      const billTotal = Number(bill.total) || 0;
      const billDiscount = Number(bill.discount) || 0;
      grossSales += billTotal;
      totalDiscount += billDiscount;

      const cashierName = String(bill.userName || bill.billerName || 'Store Counter').trim() || 'Store Counter';
      if (!cashierMap[cashierName]) {
        cashierMap[cashierName] = { name: cashierName, bills: 0, sales: 0, profit: 0 };
      }
      cashierMap[cashierName].bills += 1;
      cashierMap[cashierName].sales += billTotal;

      let billCogs = 0;
      let billProfit = 0;
      const items = Array.isArray(bill.items) ? bill.items : [];
      items.forEach((item: any) => {
        const qty = Math.max(1, Number(item.quantity) || 1);
        const sellPrice = Number(item.price) || 0;
        const unitCost = resolveItemUnitCost(item, ts);
        const hasBuyPrice = unitCost > 0;
        const itemRev = sellPrice * qty;
        // If buy price is NOT set (unitCost <= 0), itemCogs = 0 and itemProfit = 0 (not added to profit)
        const itemCogs = hasBuyPrice ? unitCost * qty : 0;
        const itemProfit = hasBuyPrice ? itemRev - itemCogs : 0;

        totalUnitsSold += qty;
        billCogs += itemCogs;
        billProfit += itemProfit;
        shiftCogs += itemCogs;

        const key = String(item.productId || item.name || 'item').toLowerCase().trim();
        if (!itemSoldMap[key]) {
          itemSoldMap[key] = {
            name: item.name || 'Item',
            qty: 0,
            pricedQty: 0,
            unitSellPrice: sellPrice,
            unitBuyCost: hasBuyPrice ? unitCost : 0,
            revenue: 0,
            cogs: 0,
            profit: 0,
          };
        }
        itemSoldMap[key].qty += qty;
        if (hasBuyPrice) {
          itemSoldMap[key].pricedQty += qty;
        }
        itemSoldMap[key].revenue += itemRev;
        itemSoldMap[key].cogs += itemCogs;
        itemSoldMap[key].profit += itemProfit;
        itemSoldMap[key].unitBuyCost =
          itemSoldMap[key].pricedQty > 0
            ? Math.round((itemSoldMap[key].cogs / itemSoldMap[key].pricedQty) * 100) / 100
            : 0;
      });

      if (billDiscount > 0 && billProfit > 0) {
        billProfit -= billDiscount;
      }
      grossProductProfitDay += billProfit;
      cashierMap[cashierName].profit += billProfit;
    });

    let dayOtherCosts = 0;
    const dayOutlayItems: { id: string; title: string; category: string; amount: number; time: string }[] = [];
    otherCostsList.forEach((c) => {
      if (c.linkedBillId || String(c.id || '').startsWith('udhaar_bill_')) return;
      const rawDate = c.createdAt || c.date || c.timestamp;
      if (rawDate) {
        const ts = typeof rawDate === 'number' ? rawDate : new Date(rawDate).getTime();
        // Use 1:00 AM app business day cutoff for expenses/outlays
        if (!isNaN(ts) && getAppBusinessIsoDate(ts) === targetIsoDate) {
          const amt = Number(c.amount) || 0;
          dayOtherCosts += amt;
          dayOutlayItems.push({
            id: String(c.id || Math.random()),
            title: String(c.title || c.name || 'Shop Expense'),
            category: String(c.category || 'expense'),
            amount: amt,
            time: new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          });
        }
      }
    });

    const netShiftProfit = grossProductProfitDay - dayOtherCosts;
    const expectedCashInDrawer = Math.max(0, grossSales - dayOtherCosts);
    const grossMarginPctDay =
      grossSales > 0 ? Math.round((grossProductProfitDay / grossSales) * 100) : 0;
    const avgBillValue =
      completedBills.length > 0 ? Math.round(grossSales / completedBills.length) : 0;
    const heldBillsTotal = heldBills.reduce((s, b) => s + (Number(b.total) || 0), 0);
    const udharBillsTotal = udharBills.reduce((s, b) => s + (Number(b.total) || 0), 0);

    const cashiers = Object.values(cashierMap).sort((a, b) => b.sales - a.sales);
    const soldItems = Object.values(itemSoldMap).sort((a, b) => b.revenue - a.revenue);
    const maxSoldItemRev = Math.max(1, ...soldItems.map((it) => it.revenue));

    // Fallback to restored Z-Report snapshot if no live bills or expenses are loaded for this date
    const hasLiveActivity =
      completedBills.length > 0 ||
      heldBills.length > 0 ||
      udharBills.length > 0 ||
      dayOutlayItems.length > 0;

    if (!hasLiveActivity && Array.isArray(savedZReportsList) && savedZReportsList.length > 0) {
      const savedEntry = savedZReportsList.find(
        (r: any) => String(r?.date || r?.targetIsoDate || '') === targetIsoDate
      );
      if (savedEntry) {
        const sGross = Number(savedEntry.grossSales) || 0;
        const sCogs = Number(savedEntry.shiftCogs) || 0;
        const sOther = Number(savedEntry.dayOtherCosts) || 0;
        const sGrossProfit =
          savedEntry.grossProductProfitDay !== undefined
            ? Number(savedEntry.grossProductProfitDay)
            : sGross - sCogs;
        const sNetProfit =
          savedEntry.netShiftProfit !== undefined
            ? Number(savedEntry.netShiftProfit)
            : sGrossProfit - sOther;
        const sCash =
          savedEntry.expectedCashInDrawer !== undefined
            ? Number(savedEntry.expectedCashInDrawer)
            : Math.max(0, sGross - sOther);
        const sCompleted = Number(savedEntry.completedBillsCount) || 0;
        const sSoldItems = Array.isArray(savedEntry.soldItems) ? savedEntry.soldItems : [];
        return {
          dateLabel,
          targetIsoDate,
          completedBillsCount: sCompleted,
          heldBillsCount: Number(savedEntry.heldBillsCount) || 0,
          heldBillsTotal: Number(savedEntry.heldBillsTotal) || 0,
          udharBillsCount: Number(savedEntry.udharBillsCount) || 0,
          udharBillsTotal: Number(savedEntry.udharBillsTotal) || 0,
          grossSales: sGross,
          avgBillValue:
            savedEntry.avgBillValue !== undefined
              ? Number(savedEntry.avgBillValue)
              : sCompleted > 0
              ? Math.round(sGross / sCompleted)
              : 0,
          totalDiscount: Number(savedEntry.totalDiscount) || 0,
          totalUnitsSold: Number(savedEntry.totalUnitsSold) || 0,
          shiftCogs: sCogs,
          grossProductProfitDay: sGrossProfit,
          grossMarginPctDay:
            savedEntry.grossMarginPctDay !== undefined
              ? Number(savedEntry.grossMarginPctDay)
              : sGross > 0
              ? Math.round((sGrossProfit / sGross) * 100)
              : 0,
          dayOtherCosts: sOther,
          dayOutlayItems: Array.isArray(savedEntry.dayOutlayItems) ? savedEntry.dayOutlayItems : [],
          netShiftProfit: sNetProfit,
          expectedCashInDrawer: sCash,
          firstBillTime: String(savedEntry.firstBillTime || '—'),
          lastBillTime: String(savedEntry.lastBillTime || '—'),
          cashiers: Array.isArray(savedEntry.cashiers) ? savedEntry.cashiers : [],
          soldItems: sSoldItems,
          maxSoldItemRev: Math.max(1, ...sSoldItems.map((it: any) => Number(it?.revenue) || 0)),
        };
      }
    }

    return {
      dateLabel,
      targetIsoDate,
      completedBillsCount: completedBills.length,
      heldBillsCount: heldBills.length,
      heldBillsTotal,
      udharBillsCount: udharBills.length,
      udharBillsTotal,
      grossSales,
      avgBillValue,
      totalDiscount,
      totalUnitsSold,
      shiftCogs,
      grossProductProfitDay,
      grossMarginPctDay,
      dayOtherCosts,
      dayOutlayItems,
      netShiftProfit,
      expectedCashInDrawer,
      firstBillTime: firstBillTs
        ? new Date(firstBillTs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '—',
      lastBillTime: lastBillTs
        ? new Date(lastBillTs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        : '—',
      cashiers,
      soldItems,
      maxSoldItemRev,
    };
  }, [bills, zReportDatePreset, zReportCustomDate, otherCostsList, productLookup, savedZReportsList]);

  const stepZReportDate = (deltaDays: number) => {
    triggerHaptic('selection');
    const [y, m, d] = zReportData.targetIsoDate.split('-').map(Number);
    const base = new Date(y, (m || 1) - 1, d || 1);
    base.setDate(base.getDate() + deltaDays);
    const nowBiz = getAppBusinessDate();
    const todayZero = new Date(nowBiz.getFullYear(), nowBiz.getMonth(), nowBiz.getDate()).getTime();
    const yestZero = todayZero - 86400000;
    const nextZero = new Date(base.getFullYear(), base.getMonth(), base.getDate()).getTime();
    if (nextZero > todayZero) return;

    const nextIso = `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, '0')}-${String(base.getDate()).padStart(2, '0')}`;
    setZReportCustomDate(nextIso);
    if (nextZero === todayZero) {
      setZReportDatePreset('today');
    } else if (nextZero === yestZero) {
      setZReportDatePreset('yesterday');
    } else {
      setZReportDatePreset('custom');
    }
  };

  const formatSignedMoney = (val: number, showPlus = false): string => {
    const num = Number(val) || 0;
    if (num < 0) return `-₹${formatPrice(Math.abs(num))}`;
    if (num > 0 && showPlus) return `+₹${formatPrice(num)}`;
    return `₹${formatPrice(num)}`;
  };

  const handleCopyZReport = () => {
    triggerHaptic('selection');
    const lines = [
      `📊 DAILY Z-REPORT (${zReportData.dateLabel})`,
      `Hours: ${zReportData.completedBillsCount > 0 ? `${zReportData.firstBillTime} – ${zReportData.lastBillTime}` : 'No sales'}`,
      `----------------------------------------`,
      `Total Sales:      ₹${formatPrice(zReportData.grossSales)} (${zReportData.completedBillsCount} bills, ${zReportData.totalUnitsSold} items)`,
      `Item Buy Cost:   -₹${formatPrice(zReportData.shiftCogs)}`,
      zReportData.dayOtherCosts > 0
        ? `Shop Expenses:   -₹${formatPrice(zReportData.dayOtherCosts)}`
        : null,
      `${zReportData.netShiftProfit >= 0 ? 'Final Profit:    ' : 'Net Loss:        '} ${formatSignedMoney(zReportData.netShiftProfit, true)}`,
      `Cash in Drawer:   ₹${formatPrice(zReportData.expectedCashInDrawer)}`,
      zReportData.udharBillsCount > 0
        ? `Pending Udhar:    ₹${formatPrice(zReportData.udharBillsTotal)} (${zReportData.udharBillsCount} bills)`
        : null,
      zReportData.heldBillsCount > 0
        ? `Bills on Hold:    ₹${formatPrice(zReportData.heldBillsTotal)} (${zReportData.heldBillsCount} bills)`
        : null,
      zReportData.soldItems.length > 0 ? `----------------------------------------` : null,
      zReportData.soldItems.length > 0 ? `TOP ITEMS SOLD:` : null,
      ...zReportData.soldItems.slice(0, 12).map(
        (it) =>
          `• ${it.name} (${it.qty}x) — ₹${formatPrice(it.revenue)} (${formatSignedMoney(it.profit, true)})`
      ),
    ].filter(Boolean);

    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(lines.join('\n')).catch(() => {});
    }
    setCopiedZReport(true);
    setTimeout(() => setCopiedZReport(false), 2400);
  };

  const handlePrintZReport = async () => {
    if (printingZReport) return;
    const livePrinter = getPrinterState();
    if (!livePrinter.connected) {
      triggerHaptic('error');
      setPrintingZReport(false);
      setZReportPrinterAlert(true);
      return;
    }
    setZReportPrinterAlert(false);
    triggerHaptic('heavy');
    setPrintingZReport(true);
    try {
      const sentDirect = await sendEscPosZReportToConnectedPrinter(zReportData);
      if (!sentDirect) {
        triggerIsolatedZReportPrint(zReportData);
      }
      triggerHaptic('success');
    } catch {
      triggerHaptic('error');
    } finally {
      setTimeout(() => setPrintingZReport(false), 1000);
    }
  };

  // ============================================================================
  // AI STORE INTELLIGENCE ENGINE (100% Grounded in Existing Catalog & Real Bills)
  // ============================================================================
  const aiInsights = useMemo(() => {
    const now = Date.now();
    const sevenDaysAgo = now - 7 * 86400000;
    const thirtyDaysAgo = now - 30 * 86400000;

    // Lookup set of existing catalog products so we never recommend non-existent items
    const catalogById = new Map<string, any>();
    const catalogByName = new Map<string, any>();
    products.forEach((p) => {
      if (p.id) catalogById.set(String(p.id).toLowerCase().trim(), p);
      if (p.name) catalogByName.set(String(p.name).toLowerCase().trim(), p);
    });

    const sold7dById: Record<string, number> = {};
    const sold30dById: Record<string, number> = {};
    const rev30dById: Record<string, number> = {};
    const cogs30dById: Record<string, number> = {};
    const profit30dById: Record<string, number> = {};
    const pairMap: Record<
      string,
      { aName: string; bName: string; aPrice: number; bPrice: number; count: number }
    > = {};
    const dayOfWeekTotals = [0, 0, 0, 0, 0, 0, 0];
    const dayOfWeekCounts = [0, 0, 0, 0, 0, 0, 0];

    // Time-of-day shift buckets: Morning (6-12), Afternoon (12-17), Evening (17-21), Night (21-6)
    const timeBuckets = [
      { id: 'morning', label: 'Morning', range: '6 AM – 12 PM', revenue: 0, bills: 0 },
      { id: 'afternoon', label: 'Afternoon', range: '12 PM – 5 PM', revenue: 0, bills: 0 },
      { id: 'evening', label: 'Evening', range: '5 PM – 9 PM', revenue: 0, bills: 0 },
      { id: 'night', label: 'Late / Night', range: '9 PM – 6 AM', revenue: 0, bills: 0 },
    ];

    let revenueLast7d = 0;
    let revenuePrev7d = 0;
    let billsLast7d = 0;

    bills.forEach((bill) => {
      if (bill.status === 'on_hold' || (bill as any).status === 'on_udhar') return;
      const ts = new Date(bill.date).getTime();
      const billTotal = Number(bill.total) || 0;
      const d = new Date(bill.date);
      if (!isNaN(d.getTime())) {
        const dow = d.getDay();
        dayOfWeekTotals[dow] += billTotal;
        dayOfWeekCounts[dow] += 1;

        const hr = d.getHours();
        if (hr >= 6 && hr < 12) {
          timeBuckets[0].revenue += billTotal;
          timeBuckets[0].bills += 1;
        } else if (hr >= 12 && hr < 17) {
          timeBuckets[1].revenue += billTotal;
          timeBuckets[1].bills += 1;
        } else if (hr >= 17 && hr < 21) {
          timeBuckets[2].revenue += billTotal;
          timeBuckets[2].bills += 1;
        } else {
          timeBuckets[3].revenue += billTotal;
          timeBuckets[3].bills += 1;
        }
      }

      if (ts >= sevenDaysAgo) {
        revenueLast7d += billTotal;
        billsLast7d += 1;
      } else if (ts >= now - 14 * 86400000 && ts < sevenDaysAgo) {
        revenuePrev7d += billTotal;
      }

      const items = Array.isArray(bill.items) ? bill.items : [];
      items.forEach((item: any) => {
        const key = String(item.productId || item.name || '').toLowerCase().trim();
        const nameKey = String(item.name || '').toLowerCase().trim();
        const qty = Number(item.quantity) || 1;
        const price = Number(item.price) || 0;
        const unitCost = resolveItemUnitCost(item, ts);
        const hasBuyPrice = unitCost > 0;
        const itemProfit = hasBuyPrice ? qty * (price - unitCost) : 0;
        const itemCogs = hasBuyPrice ? qty * unitCost : 0;

        if (ts >= sevenDaysAgo) {
          sold7dById[key] = (sold7dById[key] || 0) + qty;
          if (nameKey && nameKey !== key) sold7dById[nameKey] = (sold7dById[nameKey] || 0) + qty;
        }
        if (ts >= thirtyDaysAgo) {
          sold30dById[key] = (sold30dById[key] || 0) + qty;
          rev30dById[key] = (rev30dById[key] || 0) + qty * price;
          cogs30dById[key] = (cogs30dById[key] || 0) + itemCogs;
          profit30dById[key] = (profit30dById[key] || 0) + itemProfit;
          if (nameKey && nameKey !== key) {
            sold30dById[nameKey] = (sold30dById[nameKey] || 0) + qty;
            rev30dById[nameKey] = (rev30dById[nameKey] || 0) + qty * price;
            cogs30dById[nameKey] = (cogs30dById[nameKey] || 0) + itemCogs;
            profit30dById[nameKey] = (profit30dById[nameKey] || 0) + itemProfit;
          }
        }
      });

      // Co-purchase basket analysis (ONLY for products that currently exist in the user's catalog)
      for (let i = 0; i < items.length; i++) {
        for (let j = i + 1; j < items.length; j++) {
          const itemA = items[i];
          const itemB = items[j];
          const prodA =
            catalogById.get(String(itemA?.productId || '').toLowerCase().trim()) ||
            catalogByName.get(String(itemA?.name || '').toLowerCase().trim());
          const prodB =
            catalogById.get(String(itemB?.productId || '').toLowerCase().trim()) ||
            catalogByName.get(String(itemB?.name || '').toLowerCase().trim());

          // Skip if either item is not in the user's existing products list
          if (!prodA || !prodB || prodA.id === prodB.id) continue;

          const n1 = prodA.name;
          const n2 = prodB.name;
          const p1 = Number(prodA.price) || 0;
          const p2 = Number(prodB.price) || 0;
          const sorted =
            n1.localeCompare(n2) <= 0
              ? { aName: n1, bName: n2, aPrice: p1, bPrice: p2 }
              : { aName: n2, bName: n1, aPrice: p2, bPrice: p1 };
          const pKey = `${sorted.aName.toLowerCase()}___${sorted.bName.toLowerCase()}`;
          if (!pairMap[pKey]) {
            pairMap[pKey] = { ...sorted, count: 0 };
          }
          pairMap[pKey].count += 1;
        }
      }
    });

    // Analyze each existing product in the catalog
    const analyzedProducts = products.map((p) => {
      const idKey = String(p.id || '').toLowerCase().trim();
      const nameKey = String(p.name || '').toLowerCase().trim();
      const units7d = Math.max(sold7dById[idKey] || 0, sold7dById[nameKey] || 0);
      const units30d = Math.max(
        sold30dById[idKey] || 0,
        sold30dById[nameKey] || 0,
        Number(p.soldCount) || 0
      );
      const rev30d = Math.max(
        rev30dById[idKey] || 0,
        rev30dById[nameKey] || 0,
        units30d * (Number(p.price) || 0)
      );
      const stock = Number(p.stock) || 0;
      const price = Number(p.price) || 0;
      const activeBuyCost = getEffectiveProductCost(p, now);
      const hasBuyPrice = activeBuyCost > 0;
      const unitProfit = hasBuyPrice ? price - activeBuyCost : 0;
      const hasRecorded30dBills =
        profit30dById[idKey] !== undefined || profit30dById[nameKey] !== undefined;
      const profit30d = hasRecorded30dBills
        ? Math.max(
            profit30dById[idKey] ?? -Infinity,
            profit30dById[nameKey] ?? -Infinity
          )
        : hasBuyPrice
        ? units30d * (price - activeBuyCost)
        : 0;

      const dailyVelocity = units7d > 0 ? units7d / 7 : units30d / 30;
      const weeklyVelocity = Math.round(dailyVelocity * 7 * 10) / 10;
      const daysOfStockLeft =
        dailyVelocity > 0 ? Math.round(stock / dailyVelocity) : stock === 0 ? 0 : 99;

      // Recommended quantity to buy for next 14 days of demand + safety buffer
      const target14dStock = Math.max(15, Math.ceil(dailyVelocity * 14) + 6);
      const recommendedBuyQty = Math.max(5, target14dStock - stock);
      const coveragePct = Math.min(100, Math.round((stock / Math.max(1, target14dStock)) * 100));

      let urgency: 'critical' | 'soon' | 'buffer' | 'healthy' = 'healthy';
      let statusLabel = 'Healthy stock';
      let reason = '';
      if (stock <= 0) {
        urgency = 'critical';
        statusLabel = 'Out of stock (0)';
        reason =
          units30d > 0
            ? `Sold ${units30d} units recently · Refill urgently`
            : '0 units on shelf · Refill to avoid missed sales';
      } else if (stock <= 5 || (dailyVelocity > 0.4 && daysOfStockLeft <= 4)) {
        urgency = 'soon';
        statusLabel = `Low stock (${stock} left)`;
        reason =
          daysOfStockLeft <= 4 && dailyVelocity > 0
            ? `Lasts ~${Math.max(1, daysOfStockLeft)}d at current sales pace`
            : `Near stockout threshold · Sold ${units30d} units`;
      } else if (units30d >= 4 && stock < target14dStock) {
        urgency = 'buffer';
        statusLabel = `Fast seller (${stock} in stock)`;
        reason = `Selling ~${Math.max(1, Math.round(weeklyVelocity))}/wk · Top up for 14d demand`;
      } else {
        reason = `${stock} in stock · ${units30d} sold in 30d`;
      }

      return {
        ...p,
        stock,
        price,
        activeBuyCost,
        unitProfit,
        profit30d,
        units7d,
        units30d,
        rev30d,
        dailyVelocity,
        weeklyVelocity,
        daysOfStockLeft,
        target14dStock,
        recommendedBuyQty,
        coveragePct,
        urgency,
        statusLabel,
        reason,
      };
    });

    // Strict restock queue from existing products only
    const buyNextList = analyzedProducts
      .filter((p) => p.urgency !== 'healthy')
      .sort((a, b) => {
        const rank = { critical: 3, soon: 2, buffer: 1, healthy: 0 };
        if (rank[b.urgency] !== rank[a.urgency]) return rank[b.urgency] - rank[a.urgency];
        return b.units30d - a.units30d || a.stock - b.stock;
      });

    // If all existing products have healthy stock, show the top most-sold existing items with their next refill qty
    const topWatchList =
      buyNextList.length > 0
        ? buyNextList
        : [...analyzedProducts]
            .sort((a, b) => b.units30d - a.units30d || a.stock - b.stock)
            .slice(0, 5)
            .map((p) => ({
              ...p,
              urgency: 'buffer' as const,
              statusLabel: `${p.stock} in stock`,
              recommendedBuyQty: Math.max(5, Math.ceil(p.dailyVelocity * 7) || 10),
              coveragePct: 100,
              reason: `Well stocked (${p.units30d} sold) · Next cycle refill`,
            }));

    const totalBuyUnits = topWatchList
      .slice(0, 6)
      .reduce((sum, item) => sum + item.recommendedBuyQty, 0);

    const estRestockBudget = topWatchList
      .slice(0, 6)
      .reduce(
        (sum, item) =>
          sum + item.recommendedBuyQty * (item.activeBuyCost > 0 ? item.activeBuyCost : item.price),
        0
      );

    // Category Revenue Breakdown (from existing products)
    const totalCatalogRev30d = Math.max(
      1,
      analyzedProducts.reduce((sum, p) => sum + p.rev30d, 0)
    );
    const categoryMap: Record<
      string,
      { name: string; revenue: number; profit: number; units: number; itemCount: number; stockUnits: number }
    > = {};
    analyzedProducts.forEach((p) => {
      const rawCat = String(p.category || 'General').trim();
      const catName = rawCat.charAt(0).toUpperCase() + rawCat.slice(1).toLowerCase();
      if (!categoryMap[catName]) {
        categoryMap[catName] = {
          name: catName,
          revenue: 0,
          profit: 0,
          units: 0,
          itemCount: 0,
          stockUnits: 0,
        };
      }
      categoryMap[catName].revenue += p.rev30d;
      categoryMap[catName].profit += p.profit30d;
      categoryMap[catName].units += p.units30d;
      categoryMap[catName].itemCount += 1;
      categoryMap[catName].stockUnits += p.stock;
    });

    const categoryBreakdown = Object.values(categoryMap)
      .sort((a, b) => b.revenue - a.revenue || b.units - a.units)
      .map((c) => ({
        ...c,
        sharePct: Math.max(4, Math.round((c.revenue / totalCatalogRev30d) * 100)),
      }));

    // Top Champions vs Slow/Overstocked Catalog Items
    const topChampions = [...analyzedProducts]
      .sort((a, b) => b.rev30d - a.rev30d || b.units30d - a.units30d)
      .slice(0, 5)
      .map((item) => ({
        ...item,
        revSharePct: Math.round((item.rev30d / totalCatalogRev30d) * 100),
      }));

    const maxChampionRev = Math.max(1, topChampions[0]?.rev30d || 1);

    const slowMovers = analyzedProducts
      .filter((p) => p.stock >= 5 && p.units30d <= 1)
      .sort((a, b) => b.stock * b.price - a.stock * a.price)
      .slice(0, 4);

    const lockedCapital = slowMovers.reduce((sum, item) => sum + item.stock * item.price, 0);

    // 7-Day Forecast & Peak Day
    const projectedNext7d =
      revenueLast7d > 0
        ? Math.round(
            revenueLast7d *
              (revenuePrev7d > 0
                ? Math.min(1.25, Math.max(0.85, revenueLast7d / revenuePrev7d))
                : 1.08)
          )
        : Math.round((totalAmount / 30) * 7);

    const growthPct =
      revenuePrev7d > 0
        ? Math.round(((revenueLast7d - revenuePrev7d) / revenuePrev7d) * 100)
        : revenueLast7d > 0
        ? 12
        : 0;

    const avgOrderValue =
      bills.length > 0
        ? Math.round(bills.reduce((s, b) => s + (Number(b.total) || 0), 0) / bills.length)
        : 0;

    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const shortDays = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    let bestDowIdx = 0;
    for (let i = 1; i < 7; i++) {
      if (dayOfWeekTotals[i] > dayOfWeekTotals[bestDowIdx]) {
        bestDowIdx = i;
      }
    }
    const maxDowRev = Math.max(1, ...dayOfWeekTotals);
    const weekdayBreakdown = shortDays.map((label, idx) => ({
      label,
      total: dayOfWeekTotals[idx],
      count: dayOfWeekCounts[idx],
      pct: Math.max(8, Math.round((dayOfWeekTotals[idx] / maxDowRev) * 100)),
      isPeak: dayOfWeekTotals[bestDowIdx] > 0 && idx === bestDowIdx,
    }));

    const peakDayName =
      dayOfWeekTotals[bestDowIdx] > 0 ? dayNames[bestDowIdx] : 'No peak day yet';

    // Time-of-day rush hour calculations
    const maxShiftRev = Math.max(1, ...timeBuckets.map((b) => b.revenue));
    let bestShiftIdx = 0;
    for (let i = 1; i < timeBuckets.length; i++) {
      if (timeBuckets[i].revenue > timeBuckets[bestShiftIdx].revenue) {
        bestShiftIdx = i;
      }
    }
    const shiftBreakdown = timeBuckets.map((b, idx) => ({
      ...b,
      pct: b.revenue > 0 ? Math.max(10, Math.round((b.revenue / maxShiftRev) * 100)) : 6,
      isPeak: timeBuckets[bestShiftIdx].revenue > 0 && idx === bestShiftIdx,
    }));

    // Real Co-Purchased Pairs (Strictly from existing catalog products)
    const realPairs = Object.values(pairMap)
      .sort((a, b) => b.count - a.count)
      .slice(0, 3)
      .map((pair) => {
        const regularTotal = pair.aPrice + pair.bPrice;
        return {
          title: `${pair.aName} + ${pair.bName}`,
          regularPrice: regularTotal,
          count: pair.count,
          frequencyLabel: `Bought together in ${pair.count} ${pair.count === 1 ? 'bill' : 'bills'}`,
        };
      });

    return {
      topWatchList,
      hasUrgentRestock: buyNextList.length > 0,
      totalBuyUnits,
      estRestockBudget,
      categoryBreakdown,
      topChampions,
      maxChampionRev,
      slowMovers,
      lockedCapital,
      projectedNext7d,
      revenueLast7d,
      billsLast7d,
      growthPct,
      avgOrderValue,
      peakDayName,
      weekdayBreakdown,
      shiftBreakdown,
      combos: realPairs,
    };
  }, [products, bills, totalAmount]);

  // Copy Wholesale Shopping List (Strictly existing catalog products)
  const handleCopyShoppingList = () => {
    triggerHaptic('selection');
    const lines = [
      `SHOP RESTOCK LIST (${new Date().toLocaleDateString()})`,
      '----------------------------------------',
      ...aiInsights.topWatchList.slice(0, 6).map(
        (item, idx) =>
          `${idx + 1}. ${item.name} — Buy +${item.recommendedBuyQty} units (In stock: ${item.stock} · ₹${formatPrice(item.price)}/u)`
      ),
      '----------------------------------------',
      `Total to Buy: ${aiInsights.totalBuyUnits} units · Est. Value: ₹${formatPrice(aiInsights.estRestockBudget)}`,
    ];
    const text = lines.join('\n');
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text).catch(() => {});
    }
    setCopiedShoppingList(true);
    setTimeout(() => setCopiedShoppingList(false), 2200);
  };

  // Copy AI Advisor Response
  const handleCopyAiAdvice = () => {
    if (!aiResponse) return;
    triggerHaptic('selection');
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(aiResponse).catch(() => {});
    }
    setCopiedAiAdvice(true);
    setTimeout(() => setCopiedAiAdvice(false), 2000);
  };

  // Run Live Gemini AI Strategy Analysis (Strictly grounded in existing catalog)
  const runAiAdvisorQuery = async (promptText: string, label?: string) => {
    const clean = promptText.trim();
    if (!clean || aiLoading) return;
    triggerHaptic('medium');
    setActivePromptLabel(label || clean);
    setAiLoading(true);
    setAiResponse('');

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayBills = bills.filter((b) => new Date(b.date).getTime() >= today.getTime());
    const todayRev = todayBills.reduce((s, b) => s + (Number(b.total) || 0), 0);

    const storeCtx: StoreContext = {
      products,
      recentBills: bills.slice(0, 15),
      otherCosts: otherCostsList,
      totalRevenueToday: todayRev,
      billsCountToday: todayBills.length,
    };

    const catalogGroundedPrompt = `${clean} (IMPORTANT: Only reference and recommend products that already exist in my current catalog list. Do not suggest products that are not in my catalog.)`;

    try {
      await askGeminiAssistantStream(
        catalogGroundedPrompt,
        [],
        storeCtx,
        (chunkText) => {
          setAiResponse(chunkText);
        },
        (finalData) => {
          setAiResponse(finalData.reply || '');
          setAiLoading(false);
          triggerHaptic('light');
        }
      );
    } catch {
      setAiLoading(false);
    }
  };

  // Touch/Pointer Drag helper so sliders slide smoothly on both tap AND finger-drag on mobile
  const handleTimeframePointerMove = (e: React.TouchEvent | React.MouseEvent) => {
    const track = timeframeTrackRef.current;
    if (!track) return;
    const clientX = 'touches' in e ? e.touches[0]?.clientX : e.buttons === 1 ? e.clientX : null;
    if (clientX == null) return;
    const rect = track.getBoundingClientRect();
    const relX = clientX - rect.left;
    const nextTab: TimeframeTab = relX < rect.width / 2 ? '30days' : 'year';
    if (nextTab !== activeTab) {
      triggerHaptic('selection');
      setActiveTab(nextTab);
    }
  };

  const aiTabs: { id: AiFeatureTab; label: string; icon: React.ReactNode }[] = [
    { id: 'buy_next', label: 'Buy Next', icon: <ShoppingBag size={13} /> },
    { id: 'velocity', label: 'Velocity', icon: <Flame size={13} /> },
    { id: 'patterns', label: 'Patterns', icon: <BarChart3 size={13} /> },
    { id: 'advisor', label: 'Ask AI', icon: <Sparkles size={13} /> },
  ];

  const activeAiTabIndex = Math.max(
    0,
    aiTabs.findIndex((t) => t.id === aiTab)
  );

  const handleAiTrackTouchMove = (e: React.TouchEvent) => {
    const track = aiTrackRef.current;
    if (!track || !e.touches[0]) return;
    const rect = track.getBoundingClientRect();
    const relX = Math.max(0, Math.min(rect.width - 1, e.touches[0].clientX - rect.left));
    const idx = Math.min(
      aiTabs.length - 1,
      Math.max(0, Math.floor((relX / rect.width) * aiTabs.length))
    );
    const next = aiTabs[idx]?.id;
    if (next && next !== aiTab) {
      triggerHaptic('selection');
      setAiTab(next);
    }
  };

  if (!isAdmin) {
    return <Navigate to="/admin" replace />;
  }

  const pageTransition = useOptimizedTransition({ duration: 0.35, ease: [0.16, 1, 0.3, 1] });
  const gpuClass = useHardwareAcceleration();

  const netStoreProfit = grossProductProfit - otherCostsAmount;
  const grossMarginPct =
    totalAmount > 0 ? Math.round((grossProductProfit / totalAmount) * 100) : 0;
  const netRetentionPct =
    totalAmount > 0 ? Math.max(0, Math.round((netStoreProfit / totalAmount) * 100)) : 100;

  // Clean formatter for AI responses so markdown symbols don't look messy
  const formattedAiLines = useMemo(() => {
    if (!aiResponse) return [];
    return aiResponse
      .split('\n')
      .map((line) => line.replace(/\*\*/g, '').trim())
      .filter((line) => line.length > 0);
  }, [aiResponse]);

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.98 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.25, ease: [0.16, 1, 0.3, 1] } }}
      transition={pageTransition}
      className={`min-h-full flex flex-col pb-6 px-4 pt-12 w-full max-w-lg mx-auto ${gpuClass}`}
    >
      {/* Top Bar: Back + Title + Z-Report Trigger */}
      <header className="mb-4 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <button
            type="button"
            onClick={() => {
              triggerHaptic('heavy');
              navigate(-1);
            }}
            className="w-10 h-10 shrink-0 flex items-center justify-center bg-slate-200/80 dark:bg-slate-800 rounded-full hover:scale-105 active:scale-95 transition-all text-slate-700 dark:text-slate-200 cursor-pointer"
          >
            <ArrowLeft size={19} />
          </button>
          <h1 className="text-2xl font-extrabold tracking-tight text-slate-900 dark:text-white truncate">
            Analytics
          </h1>
        </div>

        <button
          type="button"
          onClick={() => {
            triggerHaptic('medium');
            setIsZReportOpen(true);
          }}
          className="h-10 px-3.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold flex items-center gap-1.5 shadow-xs active:scale-95 transition-all whitespace-nowrap shrink-0 cursor-pointer"
        >
          <FileText size={14} />
          <span>Z-Report</span>
        </button>
      </header>

      {/* Timeframe Segmented Control */}
      <div
        ref={timeframeTrackRef}
        onTouchStart={handleTimeframePointerMove}
        onTouchMove={handleTimeframePointerMove}
        onPointerMove={(e) => {
          if (e.buttons === 1) handleTimeframePointerMove(e);
        }}
        className="relative grid grid-cols-2 p-1 mb-4 bg-slate-200/70 dark:bg-slate-900/90 border border-slate-200/80 dark:border-slate-800 rounded-2xl select-none touch-pan-y isolate"
      >
        <div
          aria-hidden="true"
          style={{
            width: 'calc((100% - 8px) / 2)',
            transform: `translate3d(${activeTab === '30days' ? 0 : 100}%, 0, 0)`,
            transition: 'transform 260ms cubic-bezier(0.22, 1, 0.36, 1)',
          }}
          className="absolute top-1 bottom-1 left-1 bg-white dark:bg-slate-800 border border-slate-200/60 dark:border-slate-700/80 rounded-xl shadow-2xs pointer-events-none will-change-transform"
        />
        {(
          [
            { id: '30days', label: '30 Days' },
            { id: 'year', label: '1 Year' },
          ] as const
        ).map((tab) => {
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                if (activeTab !== tab.id) {
                  triggerHaptic('selection');
                  setActiveTab(tab.id);
                }
              }}
              className={`relative z-10 h-9 px-4 text-xs font-bold rounded-xl outline-none transition-colors duration-200 flex items-center justify-center whitespace-nowrap cursor-pointer ${
                active
                  ? 'text-slate-900 dark:text-white'
                  : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
              }`}
            >
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* Unified Financial Overview & Profit Ledger Card */}
      <div className="rounded-3xl bg-white/90 dark:bg-slate-900/90 border border-slate-200/80 dark:border-slate-800/90 shadow-xs overflow-hidden mb-5">
        {/* Card Header: Gross Sales + Buy Prices Action */}
        <div className="p-4 pb-2 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <span className="text-[11px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 block">
              {activeTab === '30days' ? '30-Day Gross Sales' : '12-Month Gross Sales'}
            </span>
            <p className="text-3xl font-black tracking-tight text-slate-900 dark:text-white mt-0.5 font-mono tabular-nums truncate">
              ₹{formatPrice(totalAmount)}
            </p>
          </div>

          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              navigate('/admin?view=costs');
            }}
            className="h-8 px-3 rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-indigo-50 dark:hover:bg-indigo-500/15 border border-slate-200/80 dark:border-slate-700/80 text-[11px] font-bold text-slate-700 dark:text-slate-200 flex items-center gap-1.5 whitespace-nowrap shrink-0 transition-colors cursor-pointer"
          >
            <Tag size={12} className="text-indigo-600 dark:text-indigo-400" />
            <span>Buy Prices</span>
            <span className="font-mono tabular-nums text-slate-400 dark:text-slate-500">
              {costConfigSummary.configuredCount}/{costConfigSummary.totalProducts}
            </span>
          </button>
        </div>

        {/* Trend Chart */}
        <div ref={chartContainerRef} className="h-44 min-h-[176px] w-full min-w-[200px] px-2">
          {chartReadyWidth > 0 && (
            <ResponsiveContainer width="100%" height={176} minWidth={100} minHeight={176}>
              {activeTab === '30days' ? (
                <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                  <defs>
                    <linearGradient id="colorTotal" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#4f46e5" stopOpacity={0.26} />
                      <stop offset="95%" stopColor="#4f46e5" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(148,163,184,0.18)" />
                  <XAxis
                    dataKey="name"
                    axisLine={false}
                    tickLine={false}
                    tick={{ fontSize: 10, fill: '#64748b' }}
                    minTickGap={22}
                  />
                  <Tooltip
                    contentStyle={{
                      borderRadius: '14px',
                      border: '1px solid rgba(148,163,184,0.2)',
                      boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                      background: 'rgba(15,23,42,0.92)',
                      color: '#fff',
                      fontSize: '12px',
                    }}
                    itemStyle={{ color: '#818cf8', fontWeight: 700 }}
                  />
                  <Area
                    type="monotone"
                    dataKey="total"
                    name="Sales"
                    stroke="#4f46e5"
                    strokeWidth={2.5}
                    fillOpacity={1}
                    fill="url(#colorTotal)"
                    animationDuration={400}
                  />
                </AreaChart>
              ) : (
                <BarChart data={chartData} margin={{ top: 8, right: 8, left: 8, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="rgba(148,163,184,0.18)" />
                  <XAxis
                    dataKey="name"
                    axisLine={false}
                    tickLine={false}
                    tick={{ fontSize: 10, fill: '#64748b' }}
                  />
                  <Tooltip
                    contentStyle={{
                      borderRadius: '14px',
                      border: '1px solid rgba(148,163,184,0.2)',
                      boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
                      background: 'rgba(15,23,42,0.92)',
                      color: '#fff',
                      fontSize: '12px',
                    }}
                    itemStyle={{ color: '#818cf8', fontWeight: 700 }}
                    cursor={{ fill: 'rgba(79, 70, 229, 0.06)' }}
                  />
                  <Bar
                    dataKey="total"
                    name="Sales"
                    fill="#4f46e5"
                    radius={[5, 5, 0, 0]}
                    animationDuration={400}
                  />
                </BarChart>
              )}
            </ResponsiveContainer>
          )}
        </div>

        {/* Integrated 3-Column Profit & Cost Strip */}
        <div className="grid grid-cols-3 divide-x divide-slate-200/70 dark:divide-slate-800 border-t border-slate-200/70 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-950/40">
          <div className="p-3 text-center min-w-0">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 block whitespace-nowrap">
              Buy Cost
            </span>
            <span className="text-sm font-extrabold font-mono tabular-nums text-slate-800 dark:text-slate-200 mt-0.5 block truncate">
              ₹{formatPrice(totalCogs)}
            </span>
            <span className="text-[10px] font-mono tabular-nums text-slate-400 dark:text-slate-500 block whitespace-nowrap">
              COGS total
            </span>
          </div>

          <div className="p-3 text-center min-w-0">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 block whitespace-nowrap">
              {grossProductProfit >= 0 ? 'Product Profit' : 'Product Loss'}
            </span>
            <span
              className={`text-sm font-extrabold font-mono tabular-nums mt-0.5 block truncate ${
                grossProductProfit >= 0
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : 'text-rose-600 dark:text-rose-400'
              }`}
            >
              {formatSignedMoney(grossProductProfit)}
            </span>
            <span
              className={`text-[10px] font-mono tabular-nums font-semibold block whitespace-nowrap ${
                grossProductProfit >= 0
                  ? 'text-emerald-600/80 dark:text-emerald-400/80'
                  : 'text-rose-600/80 dark:text-rose-400/80'
              }`}
            >
              {grossMarginPct}% margin
            </span>
          </div>

          <div className="p-3 text-center min-w-0">
            <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 block whitespace-nowrap">
              {netStoreProfit >= 0 ? 'Net Profit' : 'Net Loss'}
            </span>
            <span
              className={`text-sm font-extrabold font-mono tabular-nums mt-0.5 block truncate ${
                netStoreProfit >= 0
                  ? 'text-indigo-600 dark:text-indigo-400'
                  : 'text-rose-600 dark:text-rose-400'
              }`}
            >
              {formatSignedMoney(netStoreProfit)}
            </span>
            <span className="text-[10px] font-mono tabular-nums text-slate-400 dark:text-slate-500 block truncate">
              {otherCostsAmount > 0 ? `-₹${formatPrice(otherCostsAmount)} costs` : 'After outlays'}
            </span>
          </div>
        </div>
      </div>

      {/* ========================================================================
          STORE INTELLIGENCE HUB (Read-Only, 100% Existing Catalog Grounded)
         ======================================================================== */}
      <section className="flex-1 flex flex-col">
        {/* Section Header */}
        <div className="flex items-center justify-between px-1 mb-3">
          <div className="flex items-center gap-2 min-w-0">
            <Sparkles size={15} className="text-indigo-600 dark:text-indigo-400 shrink-0" />
            <h2 className="text-base font-extrabold tracking-tight text-slate-900 dark:text-white truncate">
              Store Intelligence
            </h2>
          </div>

          {aiTab === 'buy_next' && products.length > 0 && (
            <button
              type="button"
              onClick={handleCopyShoppingList}
              className="h-8 px-3 rounded-xl bg-slate-900 dark:bg-indigo-600 hover:bg-slate-800 dark:hover:bg-indigo-500 text-white text-[11px] font-bold flex items-center gap-1.5 transition-all active:scale-95 whitespace-nowrap shrink-0 cursor-pointer"
            >
              {copiedShoppingList ? (
                <>
                  <Check size={12} className="text-emerald-300" />
                  <span>Copied</span>
                </>
              ) : (
                <>
                  <Copy size={12} />
                  <span>Copy List</span>
                </>
              )}
            </button>
          )}
        </div>

        {/* 4-Tab Feature Slider */}
        <div
          ref={aiTrackRef}
          onTouchStart={handleAiTrackTouchMove}
          onTouchMove={handleAiTrackTouchMove}
          onPointerMove={(e) => {
            if (e.buttons !== 1) return;
            const rect = e.currentTarget.getBoundingClientRect();
            if (rect.width <= 0) return;
            const relX = Math.max(0, Math.min(rect.width - 1, e.clientX - rect.left));
            const idx = Math.min(
              aiTabs.length - 1,
              Math.max(0, Math.floor((relX / rect.width) * aiTabs.length))
            );
            const next = aiTabs[idx]?.id;
            if (next && next !== aiTab) {
              triggerHaptic('selection');
              setAiTab(next);
            }
          }}
          className="relative grid grid-cols-4 p-1 mb-3.5 bg-slate-200/70 dark:bg-slate-900/90 border border-slate-200/80 dark:border-slate-800 rounded-2xl select-none touch-pan-y isolate"
        >
          <div
            aria-hidden="true"
            style={{
              width: 'calc((100% - 8px) / 4)',
              transform: `translate3d(${activeAiTabIndex * 100}%, 0, 0)`,
              transition: 'transform 260ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
            className="absolute top-1 bottom-1 left-1 bg-white dark:bg-slate-800 border border-slate-200/60 dark:border-slate-700/80 rounded-xl shadow-2xs pointer-events-none will-change-transform"
          />
          {aiTabs.map((tab) => {
            const active = aiTab === tab.id;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => {
                  if (aiTab !== tab.id) {
                    triggerHaptic('selection');
                    setAiTab(tab.id);
                  }
                }}
                className={`relative z-10 h-9 px-1 rounded-xl text-[11px] font-bold outline-none transition-colors duration-200 flex items-center justify-center gap-1 whitespace-nowrap shrink-0 cursor-pointer ${
                  active
                    ? 'text-slate-900 dark:text-white'
                    : 'text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200'
                }`}
              >
                {tab.icon}
                <span>{tab.label}</span>
              </button>
            );
          })}
        </div>

        {/* AI Feature Content Area */}
        <AnimatePresence mode="wait">
          {/* ====================================================================
              TAB 1: BUY NEXT (Restock Planner)
             ==================================================================== */}
          {aiTab === 'buy_next' && (
            <motion.div
              key="ai-tab-buy-next"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.18 }}
              className="space-y-3 flex-1 flex flex-col"
            >
              <div className="rounded-3xl bg-white/90 dark:bg-slate-900/90 border border-slate-200/80 dark:border-slate-800/90 shadow-xs overflow-hidden">
                {products.length > 0 && (
                  <div className="grid grid-cols-3 divide-x divide-slate-200/70 dark:divide-slate-800 border-b border-slate-200/70 dark:border-slate-800 bg-slate-50/60 dark:bg-slate-950/40 p-3 text-center">
                    <div className="min-w-0">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 block whitespace-nowrap">
                        Priority
                      </span>
                      <span className="font-mono tabular-nums font-extrabold text-slate-900 dark:text-white text-xs sm:text-sm mt-0.5 block whitespace-nowrap">
                        {Math.min(6, aiInsights.topWatchList.length)} items
                      </span>
                    </div>
                    <div className="min-w-0">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 block whitespace-nowrap">
                        Order Qty
                      </span>
                      <span className="font-mono tabular-nums font-extrabold text-indigo-600 dark:text-indigo-400 text-xs sm:text-sm mt-0.5 block whitespace-nowrap">
                        +{aiInsights.totalBuyUnits} units
                      </span>
                    </div>
                    <div className="min-w-0">
                      <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 block whitespace-nowrap">
                        Est. Value
                      </span>
                      <span className="font-mono tabular-nums font-extrabold text-emerald-600 dark:text-emerald-400 text-xs sm:text-sm mt-0.5 block truncate">
                        ₹{formatPrice(aiInsights.estRestockBudget)}
                      </span>
                    </div>
                  </div>
                )}

                {products.length === 0 ? (
                  <div className="py-10 px-6 text-center">
                    <p className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                      No products in catalog
                    </p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 mt-1">
                      Add products in the Stock tab to see restock quantities.
                    </p>
                  </div>
                ) : (
                  <div className="divide-y divide-slate-200/65 dark:divide-slate-800/80">
                    {aiInsights.topWatchList.slice(0, 6).map((item) => {
                      const isCritical = item.urgency === 'critical';
                      const isSoon = item.urgency === 'soon';
                      const imgUrl = getImageUrl(item.image);

                      return (
                        <div
                          key={item.id || item.name}
                          className="p-3.5 flex items-center justify-between gap-3"
                        >
                          <div className="w-11 h-11 rounded-2xl overflow-hidden shrink-0 bg-slate-100 dark:bg-slate-800 border border-slate-200/70 dark:border-slate-700/60">
                            {imgUrl ? (
                              <img
                                src={imgUrl}
                                alt={item.name}
                                referrerPolicy="no-referrer"
                                className="w-full h-full object-cover"
                              />
                            ) : (
                              <ProductImagePlaceholder
                                name={item.name}
                                category={item.category}
                                size={20}
                                rounded="rounded-2xl"
                                className="w-full h-full"
                                showBorder={false}
                                showShadow={false}
                                monogramSize="bottom-0 right-1.5 text-[20px] font-black"
                              />
                            )}
                          </div>

                          <div className="min-w-0 flex-1">
                            <h4 className="font-bold text-sm text-slate-900 dark:text-slate-100 truncate">
                              {item.name}
                            </h4>
                            <div className="flex items-center gap-1.5 text-[11px] mt-0.5 font-mono tabular-nums truncate">
                              <span
                                className={`font-semibold ${
                                  isCritical
                                    ? 'text-rose-600 dark:text-rose-400'
                                    : isSoon
                                    ? 'text-amber-600 dark:text-amber-400'
                                    : 'text-indigo-600 dark:text-indigo-400'
                                }`}
                              >
                                {item.statusLabel}
                              </span>
                              <span className="text-slate-300 dark:text-slate-600">·</span>
                              <span className="text-slate-500 dark:text-slate-400 font-sans truncate">
                                {item.reason}
                              </span>
                            </div>

                            <div className="mt-1.5 flex items-center gap-2">
                              <div className="flex-1 h-1.5 rounded-full bg-slate-200/80 dark:bg-slate-800 overflow-hidden">
                                <div
                                  style={{ width: `${Math.max(6, item.coveragePct)}%` }}
                                  className={`h-full rounded-full transition-all duration-300 ${
                                    isCritical
                                      ? 'bg-rose-500'
                                      : isSoon
                                      ? 'bg-amber-500'
                                      : 'bg-indigo-500'
                                  }`}
                                />
                              </div>
                              <span className="text-[10.5px] font-mono tabular-nums text-slate-400 dark:text-slate-500 shrink-0">
                                {item.stock}/{item.target14dStock}
                              </span>
                            </div>
                          </div>

                          <div className="text-right shrink-0 pl-2.5 border-l border-slate-200/70 dark:border-slate-800">
                            <span
                              className={`text-sm font-black font-mono tabular-nums block whitespace-nowrap ${
                                isCritical
                                  ? 'text-rose-600 dark:text-rose-400'
                                  : isSoon
                                  ? 'text-amber-600 dark:text-amber-400'
                                  : 'text-indigo-600 dark:text-indigo-400'
                              }`}
                            >
                              +{item.recommendedBuyQty} u
                            </span>
                            <span className="text-[10.5px] font-mono tabular-nums text-slate-400 dark:text-slate-500 block whitespace-nowrap">
                              ₹{formatPrice(item.recommendedBuyQty * item.price)}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </motion.div>
          )}

          {/* ====================================================================
              TAB 2: VELOCITY (Top Products, Categories & Overstock)
             ==================================================================== */}
          {aiTab === 'velocity' && (
            <motion.div
              key="ai-tab-velocity"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.18 }}
              className="space-y-3.5 flex-1 flex flex-col"
            >
              <div className="rounded-3xl bg-white/90 dark:bg-slate-900/90 border border-slate-200/80 dark:border-slate-800/90 shadow-xs overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-200/70 dark:border-slate-800 flex items-center justify-between bg-slate-50/50 dark:bg-slate-950/40">
                  <span className="text-xs font-extrabold text-slate-900 dark:text-white">
                    Top Selling Products (30d)
                  </span>
                  <span className="text-[11px] font-mono tabular-nums text-slate-400">
                    Sales · Profit
                  </span>
                </div>

                {aiInsights.topChampions.length === 0 ? (
                  <p className="text-xs text-slate-500 p-6 text-center">
                    Complete bills to view product velocity rankings.
                  </p>
                ) : (
                  <div className="divide-y divide-slate-200/65 dark:divide-slate-800/80">
                    {aiInsights.topChampions.map((item, idx) => {
                      const barPct = Math.max(
                        8,
                        Math.round((item.rev30d / aiInsights.maxChampionRev) * 100)
                      );
                      return (
                        <div key={item.id || idx} className="p-3.5 flex items-center gap-3">
                          <span className="w-5 text-[11px] font-mono tabular-nums font-bold text-slate-400 dark:text-slate-500 shrink-0">
                            0{idx + 1}
                          </span>
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <p className="text-sm font-bold text-slate-900 dark:text-slate-100 truncate">
                                {item.name}
                              </p>
                              <div className="text-right shrink-0 font-mono tabular-nums whitespace-nowrap">
                                <span className="text-xs sm:text-sm font-extrabold text-slate-900 dark:text-white">
                                  ₹{formatPrice(item.rev30d)}
                                </span>
                                <span
                                  className={`text-[11px] font-bold ml-1.5 ${
                                    item.profit30d >= 0
                                      ? 'text-emerald-600 dark:text-emerald-400'
                                      : 'text-rose-600 dark:text-rose-400'
                                  }`}
                                >
                                  {formatSignedMoney(item.profit30d, true)}
                                </span>
                              </div>
                            </div>
                            <div className="flex items-center justify-between text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums mt-0.5">
                              <span className="truncate">
                                {item.units30d} sold ·{' '}
                                {item.activeBuyCost > 0
                                  ? `Buy ₹${formatPrice(item.activeBuyCost)} → ₹${formatPrice(item.price)}`
                                  : `No buy price → ₹${formatPrice(item.price)}`}
                              </span>
                              <span className="shrink-0 ml-2">{item.revSharePct}%</span>
                            </div>
                            <div className="w-full h-1.5 rounded-full bg-slate-200/70 dark:bg-slate-800 mt-1.5 overflow-hidden">
                              <div
                                style={{ width: `${barPct}%` }}
                                className="h-full rounded-full bg-indigo-500 dark:bg-indigo-400"
                              />
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {aiInsights.categoryBreakdown.length > 0 && (
                <div className="rounded-3xl bg-white/90 dark:bg-slate-900/90 border border-slate-200/80 dark:border-slate-800/90 shadow-xs overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-200/70 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/40">
                    <h3 className="text-xs font-extrabold text-slate-900 dark:text-white">
                      Category Share
                    </h3>
                  </div>
                  <div className="divide-y divide-slate-200/65 dark:divide-slate-800/80">
                    {aiInsights.categoryBreakdown.map((cat) => (
                      <div key={cat.name} className="px-4 py-3 flex items-center justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between text-xs font-bold text-slate-900 dark:text-slate-100">
                            <span className="truncate">{cat.name}</span>
                            <span className="font-mono tabular-nums whitespace-nowrap ml-2">
                              ₹{formatPrice(cat.revenue)} ·{' '}
                              <span
                                className={
                                  cat.profit >= 0
                                    ? 'text-emerald-600 dark:text-emerald-400'
                                    : 'text-rose-600 dark:text-rose-400'
                                }
                              >
                                {formatSignedMoney(cat.profit, true)}
                              </span>
                            </span>
                          </div>
                          <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums mt-0.5">
                            {cat.itemCount} items · {cat.units} sold · {cat.stockUnits} in stock
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {aiInsights.slowMovers.length > 0 && (
                <div className="rounded-3xl bg-white/90 dark:bg-slate-900/90 border border-amber-300/70 dark:border-amber-500/25 shadow-xs overflow-hidden">
                  <div className="px-4 py-3 border-b border-amber-200/60 dark:border-amber-500/15 flex items-center justify-between bg-amber-50/40 dark:bg-amber-500/[0.04]">
                    <div className="flex items-center gap-1.5">
                      <AlertTriangle size={14} className="text-amber-600 dark:text-amber-400 shrink-0" />
                      <span className="text-xs font-extrabold text-slate-900 dark:text-white">
                        Slow / Overstocked
                      </span>
                    </div>
                    <span className="text-[11px] font-mono tabular-nums font-bold text-amber-700 dark:text-amber-400">
                      ₹{formatPrice(aiInsights.lockedCapital)} tied up
                    </span>
                  </div>
                  <div className="divide-y divide-slate-200/60 dark:divide-slate-800/80">
                    {aiInsights.slowMovers.map((item) => (
                      <div
                        key={item.id || item.name}
                        className="px-4 py-2.5 flex items-center justify-between text-xs gap-2"
                      >
                        <span className="font-semibold text-slate-800 dark:text-slate-200 truncate">
                          {item.name} ({item.stock} in stock)
                        </span>
                        <span className="font-mono tabular-nums text-amber-700 dark:text-amber-400 font-bold shrink-0">
                          ₹{formatPrice(item.stock * item.price)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {/* ====================================================================
              TAB 3: PATTERNS (7-Day Forecast, Rush Hours & Combos)
             ==================================================================== */}
          {aiTab === 'patterns' && (
            <motion.div
              key="ai-tab-patterns"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.18 }}
              className="space-y-3.5 flex-1 flex flex-col"
            >
              <div className="rounded-3xl bg-white/90 dark:bg-slate-900/90 border border-slate-200/80 dark:border-slate-800/90 shadow-xs overflow-hidden">
                <div className="p-4 border-b border-slate-200/70 dark:border-slate-800 grid grid-cols-2 gap-4">
                  <div className="min-w-0">
                    <span className="text-[10.5px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 block whitespace-nowrap">
                      7-Day Forecast
                    </span>
                    <p className="text-xl sm:text-2xl font-black font-mono tabular-nums text-indigo-600 dark:text-indigo-400 mt-0.5 truncate">
                      ₹{formatPrice(aiInsights.projectedNext7d)}
                    </p>
                    <p className="text-[11px] font-mono tabular-nums text-emerald-600 dark:text-emerald-400 font-semibold mt-0.5 whitespace-nowrap">
                      {aiInsights.growthPct >= 0
                        ? `+${aiInsights.growthPct}%`
                        : `${aiInsights.growthPct}%`}{' '}
                      7d trend
                    </p>
                  </div>

                  <div className="border-l border-slate-200/70 dark:border-slate-800 pl-4 min-w-0">
                    <span className="text-[10.5px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 block whitespace-nowrap">
                      Avg Bill Value
                    </span>
                    <p className="text-xl sm:text-2xl font-black font-mono tabular-nums text-slate-900 dark:text-white mt-0.5 truncate">
                      ₹{formatPrice(aiInsights.avgOrderValue)}
                    </p>
                    <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5 truncate">
                      Peak: <strong className="text-slate-800 dark:text-slate-200">{aiInsights.peakDayName}</strong>
                    </p>
                  </div>
                </div>

                <div className="p-4 bg-slate-50/40 dark:bg-slate-950/30">
                  <div className="flex items-center justify-between text-xs mb-3">
                    <span className="font-bold text-slate-700 dark:text-slate-300">
                      Weekly Traffic Rhythm
                    </span>
                    <span className="font-mono tabular-nums text-slate-400 text-[11px]">
                      {aiInsights.billsLast7d} bills (7d)
                    </span>
                  </div>
                  <div className="grid grid-cols-7 gap-2 items-end h-20 pt-2">
                    {aiInsights.weekdayBreakdown.map((day) => (
                      <div
                        key={day.label}
                        className="flex flex-col items-center gap-1.5 h-full justify-end"
                      >
                        <div className="w-full flex-1 flex items-end justify-center">
                          <div
                            style={{ height: `${day.pct}%` }}
                            className={`w-full max-w-[22px] rounded-t-md transition-all duration-300 ${
                              day.isPeak
                                ? 'bg-indigo-600 dark:bg-indigo-400'
                                : day.total > 0
                                ? 'bg-indigo-300/80 dark:bg-indigo-500/40'
                                : 'bg-slate-200 dark:bg-slate-800'
                            }`}
                          />
                        </div>
                        <span
                          className={`text-[10px] font-mono tabular-nums ${
                            day.isPeak
                              ? 'font-bold text-indigo-600 dark:text-indigo-300'
                              : 'text-slate-500 dark:text-slate-400'
                          }`}
                        >
                          {day.label}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              <div className="rounded-3xl bg-white/90 dark:bg-slate-900/90 border border-slate-200/80 dark:border-slate-800/90 shadow-xs overflow-hidden">
                <div className="px-4 py-3 border-b border-slate-200/70 dark:border-slate-800 flex items-center justify-between bg-slate-50/50 dark:bg-slate-950/40">
                  <span className="text-xs font-extrabold text-slate-900 dark:text-white">
                    Store Rush Hours
                  </span>
                  <Clock size={14} className="text-indigo-600 dark:text-indigo-400 shrink-0" />
                </div>

                <div className="divide-y divide-slate-200/65 dark:divide-slate-800/80">
                  {aiInsights.shiftBreakdown.map((shift) => (
                    <div key={shift.id} className="p-3.5 space-y-1.5">
                      <div className="flex items-center justify-between text-xs gap-2">
                        <div className="min-w-0 truncate">
                          <span className="font-bold text-slate-900 dark:text-slate-100">
                            {shift.label}
                          </span>
                          <span className="text-slate-400 dark:text-slate-500 ml-1.5 font-mono tabular-nums text-[11px]">
                            {shift.range}
                          </span>
                        </div>
                        <span className="font-mono tabular-nums font-bold text-slate-900 dark:text-slate-100 whitespace-nowrap shrink-0">
                          ₹{formatPrice(shift.revenue)} · {shift.bills}b
                        </span>
                      </div>
                      <div className="w-full h-1.5 rounded-full bg-slate-200/70 dark:bg-slate-800 overflow-hidden">
                        <div
                          style={{ width: `${shift.pct}%` }}
                          className={`h-full rounded-full ${
                            shift.isPeak
                              ? 'bg-emerald-500 dark:bg-emerald-400'
                              : 'bg-indigo-500/70 dark:bg-indigo-400/60'
                          }`}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {aiInsights.combos.length > 0 && (
                <div className="rounded-3xl bg-white/90 dark:bg-slate-900/90 border border-slate-200/80 dark:border-slate-800/90 shadow-xs overflow-hidden">
                  <div className="px-4 py-3 border-b border-slate-200/70 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/40">
                    <h3 className="text-xs font-extrabold text-slate-900 dark:text-white">
                      Frequently Bought Together
                    </h3>
                  </div>
                  <div className="divide-y divide-slate-200/65 dark:divide-slate-800/80">
                    {aiInsights.combos.map((combo, idx) => (
                      <div
                        key={idx}
                        className="px-4 py-3 flex items-center justify-between gap-3 text-xs"
                      >
                        <div className="min-w-0">
                          <p className="font-bold text-slate-900 dark:text-slate-100 truncate">
                            {combo.title}
                          </p>
                          <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
                            {combo.frequencyLabel}
                          </p>
                        </div>
                        <span className="font-mono tabular-nums font-bold text-indigo-600 dark:text-indigo-400 shrink-0">
                          ₹{formatPrice(combo.regularPrice)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </motion.div>
          )}

          {/* ====================================================================
              TAB 4: ASK AI (Live Store Advisor)
             ==================================================================== */}
          {aiTab === 'advisor' && (
            <motion.div
              key="ai-tab-advisor"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.18 }}
              className="space-y-3.5 flex-1 flex flex-col"
            >
              <div className="rounded-3xl bg-white/90 dark:bg-slate-900/90 border border-slate-200/80 dark:border-slate-800/90 shadow-xs overflow-hidden flex-1 flex flex-col justify-between">
                <div className="px-4 py-3 border-b border-slate-200/70 dark:border-slate-800 bg-slate-50/50 dark:bg-slate-950/40 flex items-center justify-between">
                  <span className="text-xs font-extrabold text-slate-900 dark:text-white">
                    AI Store Advisor ({products.length} items · {bills.length} bills)
                  </span>
                  <Zap size={14} className="text-indigo-600 dark:text-indigo-400 shrink-0" />
                </div>

                <div className="p-4 space-y-3.5 flex-1 flex flex-col justify-between">
                  <div className="grid grid-cols-2 gap-2.5">
                    {[
                      {
                        idx: '01',
                        title: 'What to Buy Next',
                        sub: 'Restock quantities',
                        prompt:
                          'Looking strictly at my existing products list and their stock and sales velocity, which of my products should I buy next and in what quantities?',
                      },
                      {
                        idx: '02',
                        title: 'Top Profit Makers',
                        sub: 'Best & slowest items',
                        prompt:
                          'Analyze my existing products and tell me which ones bring the most revenue and which ones are moving slowly.',
                      },
                      {
                        idx: '03',
                        title: 'Grow Daily Sales',
                        sub: 'Based on my bills',
                        prompt:
                          'Based on my recent bills and existing products, give me 3 practical tips to increase my daily sales and average bill value.',
                      },
                      {
                        idx: '04',
                        title: 'Cost & Net Margin',
                        sub: 'Sales vs expenses',
                        prompt:
                          'Audit my sales revenue vs recorded expenses and tell me how my net profit margin looks.',
                      },
                    ].map((q) => {
                      const isSelected = activePromptLabel === q.title;
                      return (
                        <button
                          key={q.title}
                          type="button"
                          disabled={aiLoading}
                          onClick={() => runAiAdvisorQuery(q.prompt, q.title)}
                          className={`p-3 rounded-2xl text-left border transition-all active:scale-95 cursor-pointer flex flex-col justify-between min-h-[68px] ${
                            isSelected
                              ? 'bg-indigo-600 text-white border-indigo-600 shadow-xs'
                              : 'bg-slate-50/90 dark:bg-slate-800/60 hover:bg-indigo-50/60 dark:hover:bg-indigo-500/10 text-slate-900 dark:text-slate-100 border-slate-200/80 dark:border-slate-700/70'
                          }`}
                        >
                          <div className="flex items-center justify-between w-full">
                            <span
                              className={`text-[10px] font-mono tabular-nums font-bold ${
                                isSelected
                                  ? 'text-indigo-200'
                                  : 'text-indigo-600 dark:text-indigo-400'
                              }`}
                            >
                              {q.idx}
                            </span>
                            <ArrowUpRight
                              size={13}
                              className={
                                isSelected ? 'text-white' : 'text-slate-400 dark:text-slate-500'
                              }
                            />
                          </div>
                          <div className="mt-1">
                            <p className="text-xs font-bold leading-snug truncate">{q.title}</p>
                            <p
                              className={`text-[10.5px] truncate mt-0.5 ${
                                isSelected
                                  ? 'text-indigo-100'
                                  : 'text-slate-500 dark:text-slate-400'
                              }`}
                            >
                              {q.sub}
                            </p>
                          </div>
                        </button>
                      );
                    })}
                  </div>

                  {(aiLoading || aiResponse) && (
                    <div className="rounded-2xl bg-slate-50 dark:bg-slate-950/80 border border-slate-200/80 dark:border-slate-800 overflow-hidden">
                      <div className="px-3.5 py-2 border-b border-slate-200/70 dark:border-slate-800 flex items-center justify-between">
                        <span className="text-xs font-bold text-indigo-600 dark:text-indigo-400 truncate">
                          {activePromptLabel || 'Store Analysis'}
                        </span>
                        {!aiLoading && aiResponse && (
                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              onClick={handleCopyAiAdvice}
                              className="px-2.5 py-1 rounded-lg text-[11px] font-semibold text-slate-600 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-slate-800 flex items-center gap-1 transition-colors cursor-pointer"
                            >
                              {copiedAiAdvice ? <Check size={11} /> : <Copy size={11} />}
                              <span>{copiedAiAdvice ? 'Copied' : 'Copy'}</span>
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setAiResponse('');
                                setActivePromptLabel('');
                              }}
                              aria-label="Reset analysis"
                              className="p-1 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors cursor-pointer"
                            >
                              <RotateCcw size={12} />
                            </button>
                          </div>
                        )}
                      </div>

                      <div className="p-3.5 max-h-60 overflow-y-auto space-y-2 text-xs text-slate-700 dark:text-slate-200 leading-relaxed">
                        {aiLoading && !aiResponse ? (
                          <div className="flex items-center gap-2.5 text-indigo-600 dark:text-indigo-400 font-medium py-3">
                            <RefreshCw size={14} className="animate-spin shrink-0" />
                            <span>Analyzing your catalog & bills...</span>
                          </div>
                        ) : (
                          formattedAiLines.map((line, i) => {
                            const isBullet =
                              line.startsWith('•') || line.startsWith('-') || line.startsWith('*');
                            const cleanText = isBullet ? line.replace(/^[•\-*]\s*/, '') : line;
                            return isBullet ? (
                              <div key={i} className="flex items-start gap-2 pl-1">
                                <span className="text-indigo-500 font-bold select-none">·</span>
                                <span className="flex-1">{cleanText}</span>
                              </div>
                            ) : (
                              <p
                                key={i}
                                className={
                                  line.endsWith(':')
                                    ? 'font-bold text-slate-900 dark:text-white pt-1'
                                    : ''
                                }
                              >
                                {cleanText}
                              </p>
                            );
                          })
                        )}
                      </div>
                    </div>
                  )}

                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (!aiPrompt.trim()) return;
                      const q = aiPrompt;
                      setAiPrompt('');
                      runAiAdvisorQuery(q, q);
                    }}
                    className="flex items-center gap-2 pt-1"
                  >
                    <input
                      type="text"
                      value={aiPrompt}
                      onChange={(e) => setAiPrompt(e.target.value)}
                      placeholder="Ask about your products, stock, or bills..."
                      className="flex-1 h-11 px-4 rounded-2xl text-xs bg-slate-100 dark:bg-slate-800/90 border border-slate-200/80 dark:border-slate-700/80 text-slate-900 dark:text-white placeholder:text-slate-400 focus:outline-none focus:border-indigo-500 transition-colors"
                    />
                    <button
                      type="submit"
                      disabled={!aiPrompt.trim() || aiLoading}
                      aria-label="Send question"
                      className="w-11 h-11 rounded-2xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white flex items-center justify-center shrink-0 shadow-xs active:scale-95 transition-all cursor-pointer"
                    >
                      <Send size={15} />
                    </button>
                  </form>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </section>

      {/* ========================================================================
          END-OF-DAY SHIFT CLOSING SUMMARY (Z-REPORT) MODAL
         ======================================================================== */}
      {isZReportOpen &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            onClick={() => {
              setZReportDragY(0);
              setIsZReportOpen(false);
            }}
            className="fixed inset-0 z-[1000] bg-slate-950/70 backdrop-blur-md flex items-end sm:items-center justify-center p-0 sm:p-4"
          >
            <motion.div
              onClick={(e) => e.stopPropagation()}
              initial={{ opacity: 0, y: 24, scale: 0.98 }}
              animate={{ opacity: 1, y: zReportDragY, scale: 1 }}
              exit={{ opacity: 0, y: 24, scale: 0.98 }}
              transition={
                zReportDragStartYRef.current !== null
                  ? { duration: 0 }
                  : { duration: 0.22, ease: [0.16, 1, 0.3, 1] }
              }
              className="w-full max-w-lg max-h-[92dvh] sm:max-h-[88vh] bg-white dark:bg-slate-900 rounded-t-3xl sm:rounded-3xl border border-slate-200/80 dark:border-slate-800/90 shadow-2xl flex flex-col overflow-hidden"
            >
              {/* Top Header & Date Selector (with interactive Slide-Down Handle) */}
              <div className="px-4 sm:px-5 pt-2.5 pb-3.5 bg-white dark:bg-slate-900 border-b border-slate-200/70 dark:border-slate-800/80 space-y-3 shrink-0">
                {/* Interactive Slide-Down Drag Handle */}
                <div
                  onTouchStart={(e) => {
                    const y = e.touches[0]?.clientY;
                    if (y !== undefined) zReportDragStartYRef.current = y;
                  }}
                  onTouchMove={(e) => {
                    if (zReportDragStartYRef.current === null) return;
                    const currentY = e.touches[0]?.clientY ?? zReportDragStartYRef.current;
                    const deltaY = Math.max(0, currentY - zReportDragStartYRef.current);
                    setZReportDragY(deltaY);
                  }}
                  onTouchEnd={() => {
                    const finalY = zReportDragY;
                    zReportDragStartYRef.current = null;
                    if (finalY > 65) {
                      triggerHaptic('medium');
                      setZReportDragY(0);
                      setIsZReportOpen(false);
                    } else {
                      setZReportDragY(0);
                    }
                  }}
                  onPointerDown={(e) => {
                    zReportDragStartYRef.current = e.clientY;
                    try {
                      e.currentTarget.setPointerCapture(e.pointerId);
                    } catch {}
                  }}
                  onPointerMove={(e) => {
                    if (zReportDragStartYRef.current === null || e.buttons !== 1) return;
                    const deltaY = Math.max(0, e.clientY - zReportDragStartYRef.current);
                    setZReportDragY(deltaY);
                  }}
                  onPointerUp={(e) => {
                    const finalY = zReportDragY;
                    zReportDragStartYRef.current = null;
                    try {
                      e.currentTarget.releasePointerCapture(e.pointerId);
                    } catch {}
                    if (finalY > 65) {
                      triggerHaptic('medium');
                      setZReportDragY(0);
                      setIsZReportOpen(false);
                    } else {
                      setZReportDragY(0);
                    }
                  }}
                  className="w-full py-1.5 flex items-center justify-center cursor-grab active:cursor-grabbing touch-none select-none"
                >
                  <div className="w-11 h-1.5 bg-slate-300 dark:bg-slate-700 rounded-full" />
                </div>

                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 rounded-2xl bg-indigo-500/10 dark:bg-indigo-500/15 border border-indigo-500/20 text-indigo-600 dark:text-indigo-400 flex items-center justify-center shrink-0">
                      <FileText size={18} />
                    </div>
                    <div className="min-w-0">
                      <h2 className="text-lg font-extrabold tracking-tight text-slate-900 dark:text-white truncate">
                        Daily <span className="text-indigo-600 dark:text-indigo-400">Z-Report</span>
                      </h2>
                      <p className="text-xs font-medium text-slate-500 dark:text-slate-400 truncate mt-0.5">
                        {zReportData.dateLabel}
                        {zReportData.completedBillsCount > 0
                          ? ` · ${zReportData.firstBillTime} – ${zReportData.lastBillTime}`
                          : ' · No bills yet'}
                      </p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      setZReportDragY(0);
                      setIsZReportOpen(false);
                    }}
                    aria-label="Close Z-Report"
                    className="w-9 h-9 shrink-0 aspect-square rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 flex items-center justify-center hover:bg-slate-200 dark:hover:bg-slate-700 hover:text-slate-900 dark:hover:text-white transition-colors cursor-pointer"
                  >
                    <X size={16} />
                  </button>
                </div>

                {/* Simple Date Switcher */}
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => stepZReportDate(-1)}
                      aria-label="Previous day"
                      className="w-9 h-9 shrink-0 aspect-square rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 font-bold text-sm flex items-center justify-center active:scale-95 transition-all cursor-pointer"
                    >
                      ‹
                    </button>

                    <div
                      onTouchStart={(e) => {
                        const touch = e.touches[0];
                        if (!touch) return;
                        const rect = e.currentTarget.getBoundingClientRect();
                        if (rect.width <= 0) return;
                        const presets = ['today', 'yesterday', 'custom'] as const;
                        const relX = Math.max(0, Math.min(rect.width - 1, touch.clientX - rect.left));
                        const idx = Math.min(presets.length - 1, Math.max(0, Math.floor((relX / rect.width) * presets.length)));
                        const next = presets[idx];
                        if (next && next !== zReportDatePreset) {
                          triggerHaptic('selection');
                          setZReportDatePreset(next);
                        }
                      }}
                      onTouchMove={(e) => {
                        const touch = e.touches[0];
                        if (!touch) return;
                        const rect = e.currentTarget.getBoundingClientRect();
                        if (rect.width <= 0) return;
                        const presets = ['today', 'yesterday', 'custom'] as const;
                        const relX = Math.max(0, Math.min(rect.width - 1, touch.clientX - rect.left));
                        const idx = Math.min(presets.length - 1, Math.max(0, Math.floor((relX / rect.width) * presets.length)));
                        const next = presets[idx];
                        if (next && next !== zReportDatePreset) {
                          triggerHaptic('selection');
                          setZReportDatePreset(next);
                        }
                      }}
                      onPointerMove={(e) => {
                        if (e.buttons !== 1) return;
                        const rect = e.currentTarget.getBoundingClientRect();
                        if (rect.width <= 0) return;
                        const presets = ['today', 'yesterday', 'custom'] as const;
                        const relX = Math.max(0, Math.min(rect.width - 1, e.clientX - rect.left));
                        const idx = Math.min(presets.length - 1, Math.max(0, Math.floor((relX / rect.width) * presets.length)));
                        const next = presets[idx];
                        if (next && next !== zReportDatePreset) {
                          triggerHaptic('selection');
                          setZReportDatePreset(next);
                        }
                      }}
                      className="relative grid grid-cols-3 p-1 rounded-xl bg-slate-100 dark:bg-slate-800/90 flex-1 select-none touch-pan-y isolate"
                    >
                      <div
                        aria-hidden="true"
                        style={{
                          width: 'calc((100% - 8px) / 3)',
                          transform: `translate3d(${
                            (['today', 'yesterday', 'custom'] as const).indexOf(zReportDatePreset) * 100
                          }%, 0, 0)`,
                          transition: 'transform 260ms cubic-bezier(0.22, 1, 0.36, 1)',
                        }}
                        className="absolute top-1 bottom-1 left-1 bg-indigo-600 rounded-lg shadow-xs pointer-events-none will-change-transform"
                      />
                      {(
                        [
                          { id: 'today', label: 'Today' },
                          { id: 'yesterday', label: 'Yesterday' },
                          { id: 'custom', label: 'Pick Date' },
                        ] as const
                      ).map((preset) => {
                        const active = zReportDatePreset === preset.id;
                        return (
                          <button
                            key={preset.id}
                            type="button"
                            onClick={() => {
                              if (zReportDatePreset === preset.id) return;
                              triggerHaptic('selection');
                              setZReportDatePreset(preset.id);
                            }}
                            className={`relative z-10 h-7 rounded-lg text-[11px] font-bold transition-colors whitespace-nowrap cursor-pointer ${
                              active
                                ? 'text-white'
                                : 'text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white'
                            }`}
                          >
                            {preset.label}
                          </button>
                        );
                      })}
                    </div>

                    <button
                      type="button"
                      onClick={() => stepZReportDate(1)}
                      disabled={zReportDatePreset === 'today'}
                      aria-label="Next day"
                      className="w-9 h-9 shrink-0 aspect-square rounded-xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-35 disabled:pointer-events-none text-slate-700 dark:text-slate-200 font-bold text-sm flex items-center justify-center active:scale-95 transition-all cursor-pointer"
                    >
                      ›
                    </button>
                  </div>

                  {zReportDatePreset === 'custom' && (
                    <div className="flex items-center justify-between gap-3 px-3.5 py-2 rounded-xl bg-slate-100/80 dark:bg-slate-800/70 border border-slate-200/80 dark:border-slate-700/80">
                      <span className="text-xs font-bold text-slate-600 dark:text-slate-300">
                        Select Report Date
                      </span>
                      <input
                        type="date"
                        value={zReportCustomDate}
                        onChange={(e) => setZReportCustomDate(e.target.value)}
                        className="h-8 px-2.5 rounded-lg text-xs font-mono tabular-nums font-bold bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white focus:outline-none focus:border-indigo-500"
                      />
                    </div>
                  )}
                </div>
              </div>

              {/* Scrollable Report Content */}
              <div className="p-4 sm:p-5 overflow-y-auto space-y-4 flex-1 bg-slate-50/70 dark:bg-slate-950/60">
                {/* 1. Hero Cards: Final Profit & Cash in Drawer */}
                <div className="grid grid-cols-2 gap-3">
                  {/* Final Profit / Loss Card */}
                  <div
                    className={`p-4 rounded-2xl border ${
                      zReportData.netShiftProfit >= 0
                        ? 'bg-emerald-500/[0.08] dark:bg-emerald-500/[0.12] border-emerald-500/25'
                        : 'bg-rose-500/[0.08] dark:bg-rose-500/[0.12] border-rose-500/25'
                    }`}
                  >
                    <span
                      className={`text-[11px] font-bold uppercase tracking-wider block ${
                        zReportData.netShiftProfit >= 0
                          ? 'text-emerald-700 dark:text-emerald-300'
                          : 'text-rose-700 dark:text-rose-300'
                      }`}
                    >
                      {zReportData.netShiftProfit >= 0 ? 'Final Profit' : 'Net Loss'}
                    </span>
                    <p
                      className={`text-2xl sm:text-[26px] font-black font-mono tabular-nums tracking-tight mt-1 truncate ${
                        zReportData.netShiftProfit > 0
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : zReportData.netShiftProfit < 0
                          ? 'text-rose-600 dark:text-rose-400'
                          : 'text-slate-900 dark:text-white'
                      }`}
                    >
                      {formatSignedMoney(zReportData.netShiftProfit, true)}
                    </p>
                    <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400 mt-1 block truncate">
                      After buy price &amp; costs
                    </span>
                  </div>

                  {/* Cash in Drawer Card */}
                  <div className="p-4 rounded-2xl bg-indigo-500/[0.08] dark:bg-indigo-500/[0.12] border border-indigo-500/25">
                    <span className="text-[11px] font-bold uppercase tracking-wider text-indigo-700 dark:text-indigo-300 block">
                      Cash in Drawer
                    </span>
                    <p className="text-2xl sm:text-[26px] font-black font-mono tabular-nums tracking-tight text-slate-900 dark:text-white mt-1 truncate">
                      ₹{formatPrice(zReportData.expectedCashInDrawer)}
                    </p>
                    <span className="text-[11px] font-medium text-slate-500 dark:text-slate-400 mt-1 block truncate">
                      {zReportData.dayOtherCosts > 0
                        ? `Sales minus ₹${formatPrice(zReportData.dayOtherCosts)} costs`
                        : 'Total cash from sales'}
                    </span>
                  </div>
                </div>

                {/* 2. Quick 4-Stat Overview Strip */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                  <div className="p-3 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800/90">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 block">
                      Total Sales
                    </span>
                    <span className="text-sm font-black font-mono tabular-nums text-slate-900 dark:text-white mt-0.5 block truncate">
                      ₹{formatPrice(zReportData.grossSales)}
                    </span>
                  </div>

                  <div className="p-3 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800/90">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 block">
                      Bills Done
                    </span>
                    <span className="text-sm font-black font-mono tabular-nums text-slate-900 dark:text-white mt-0.5 block truncate">
                      {zReportData.completedBillsCount}{' '}
                      <span className="text-xs font-semibold text-slate-400 dark:text-slate-500">
                        {zReportData.completedBillsCount === 1 ? 'bill' : 'bills'}
                      </span>
                    </span>
                  </div>

                  <div className="p-3 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800/90">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 block">
                      Items Sold
                    </span>
                    <span className="text-sm font-black font-mono tabular-nums text-slate-900 dark:text-white mt-0.5 block truncate">
                      {zReportData.totalUnitsSold}{' '}
                      <span className="text-xs font-semibold text-slate-400 dark:text-slate-500">
                        {zReportData.totalUnitsSold === 1 ? 'item' : 'items'}
                      </span>
                    </span>
                  </div>

                  <div className="p-3 rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800/90">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500 block">
                      Avg Bill
                    </span>
                    <span className="text-sm font-black font-mono tabular-nums text-slate-900 dark:text-white mt-0.5 block truncate">
                      ₹{formatPrice(zReportData.avgBillValue)}
                    </span>
                  </div>
                </div>

                {/* 3. Simple Profit Calculation Card */}
                <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800/90 overflow-hidden">
                  <div className="px-4 py-2.5 bg-slate-50 dark:bg-slate-800/50 border-b border-slate-200/70 dark:border-slate-800 flex items-center justify-between">
                    <span className="text-xs font-extrabold text-slate-800 dark:text-slate-200">
                      Simple Profit Breakdown
                    </span>
                    <span className="text-[11px] font-mono tabular-nums font-bold text-indigo-600 dark:text-indigo-400">
                      {zReportData.grossMarginPctDay}% Margin
                    </span>
                  </div>

                  <div className="p-4 space-y-2.5 text-xs">
                    <div className="flex items-center justify-between gap-3">
                      <span className="text-slate-600 dark:text-slate-300 font-medium">
                        Total Bill Sales{' '}
                        <span className="text-slate-400 dark:text-slate-500">
                          ({zReportData.completedBillsCount} paid)
                        </span>
                      </span>
                      <span className="font-mono tabular-nums font-bold text-slate-900 dark:text-white">
                        ₹{formatPrice(zReportData.grossSales)}
                      </span>
                    </div>

                    <div className="flex items-center justify-between gap-3">
                      <span className="text-slate-600 dark:text-slate-300 font-medium">
                        Item Buy Price{' '}
                        <span className="text-slate-400 dark:text-slate-500">
                          ({zReportData.totalUnitsSold} items)
                        </span>
                      </span>
                      <span className="font-mono tabular-nums font-semibold text-slate-600 dark:text-slate-400">
                        {zReportData.shiftCogs > 0 ? `-₹${formatPrice(zReportData.shiftCogs)}` : '₹0'}
                      </span>
                    </div>

                    <div className="flex items-center justify-between gap-3">
                      <span className="text-slate-600 dark:text-slate-300 font-medium">
                        Shop Expenses{' '}
                        <span className="text-slate-400 dark:text-slate-500">
                          ({zReportData.dayOutlayItems.length} entries)
                        </span>
                      </span>
                      <span
                        className={`font-mono tabular-nums font-semibold ${
                          zReportData.dayOtherCosts > 0
                            ? 'text-rose-600 dark:text-rose-400'
                            : 'text-slate-400 dark:text-slate-500'
                        }`}
                      >
                        {zReportData.dayOtherCosts > 0
                          ? `-₹${formatPrice(zReportData.dayOtherCosts)}`
                          : '₹0'}
                      </span>
                    </div>

                    {zReportData.totalDiscount > 0 && (
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-slate-600 dark:text-slate-300 font-medium">
                          Discounts Given
                        </span>
                        <span className="font-mono tabular-nums font-semibold text-amber-600 dark:text-amber-400">
                          -₹{formatPrice(zReportData.totalDiscount)}
                        </span>
                      </div>
                    )}

                    <div className="pt-2.5 border-t border-slate-200/80 dark:border-slate-800 flex items-center justify-between gap-3">
                      <span className="font-extrabold text-slate-900 dark:text-white text-[13px]">
                        {zReportData.netShiftProfit >= 0 ? 'Final Profit in Hand' : 'Total Net Loss'}
                      </span>
                      <span
                        className={`font-mono tabular-nums text-sm font-black ${
                          zReportData.netShiftProfit > 0
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : zReportData.netShiftProfit < 0
                            ? 'text-rose-600 dark:text-rose-400'
                            : 'text-slate-900 dark:text-white'
                        }`}
                      >
                        {formatSignedMoney(zReportData.netShiftProfit, true)}
                      </span>
                    </div>
                  </div>

                  {/* Pending Udhar / Held Bills Notice */}
                  {(zReportData.udharBillsCount > 0 || zReportData.heldBillsCount > 0) && (
                    <div className="grid grid-cols-2 divide-x divide-slate-200/80 dark:divide-slate-800 border-t border-slate-200/80 dark:border-slate-800 bg-amber-50/50 dark:bg-amber-500/[0.06]">
                      <div className="px-4 py-2.5 flex items-center justify-between gap-2">
                        <div>
                          <span className="text-[10px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-400 block">
                            Unpaid Udhar
                          </span>
                          <span className="text-[11px] text-slate-500 dark:text-slate-400">
                            {zReportData.udharBillsCount} {zReportData.udharBillsCount === 1 ? 'bill' : 'bills'}
                          </span>
                        </div>
                        <span className="font-mono tabular-nums text-xs font-extrabold text-amber-600 dark:text-amber-400">
                          ₹{formatPrice(zReportData.udharBillsTotal)}
                        </span>
                      </div>

                      <div className="px-4 py-2.5 flex items-center justify-between gap-2">
                        <div>
                          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-500 dark:text-slate-400 block">
                            On Hold
                          </span>
                          <span className="text-[11px] text-slate-500 dark:text-slate-400">
                            {zReportData.heldBillsCount} {zReportData.heldBillsCount === 1 ? 'bill' : 'bills'}
                          </span>
                        </div>
                        <span className="font-mono tabular-nums text-xs font-extrabold text-slate-700 dark:text-slate-300">
                          ₹{formatPrice(zReportData.heldBillsTotal)}
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                {/* 4. Simple Details Switcher (Items Sold / Staff / Expenses) */}
                <div className="space-y-2.5">
                  <div
                    onTouchStart={(e) => {
                      const touch = e.touches[0];
                      if (!touch) return;
                      const rect = e.currentTarget.getBoundingClientRect();
                      if (rect.width <= 0) return;
                      const tabs = ['items', 'cashiers', 'outlays'] as const;
                      const relX = Math.max(0, Math.min(rect.width - 1, touch.clientX - rect.left));
                      const idx = Math.min(tabs.length - 1, Math.max(0, Math.floor((relX / rect.width) * tabs.length)));
                      const next = tabs[idx];
                      if (next && next !== zReportSectionTab) {
                        triggerHaptic('selection');
                        setZReportSectionTab(next);
                      }
                    }}
                    onTouchMove={(e) => {
                      const touch = e.touches[0];
                      if (!touch) return;
                      const rect = e.currentTarget.getBoundingClientRect();
                      if (rect.width <= 0) return;
                      const tabs = ['items', 'cashiers', 'outlays'] as const;
                      const relX = Math.max(0, Math.min(rect.width - 1, touch.clientX - rect.left));
                      const idx = Math.min(tabs.length - 1, Math.max(0, Math.floor((relX / rect.width) * tabs.length)));
                      const next = tabs[idx];
                      if (next && next !== zReportSectionTab) {
                        triggerHaptic('selection');
                        setZReportSectionTab(next);
                      }
                    }}
                    onPointerMove={(e) => {
                      if (e.buttons !== 1) return;
                      const rect = e.currentTarget.getBoundingClientRect();
                      if (rect.width <= 0) return;
                      const tabs = ['items', 'cashiers', 'outlays'] as const;
                      const relX = Math.max(0, Math.min(rect.width - 1, e.clientX - rect.left));
                      const idx = Math.min(tabs.length - 1, Math.max(0, Math.floor((relX / rect.width) * tabs.length)));
                      const next = tabs[idx];
                      if (next && next !== zReportSectionTab) {
                        triggerHaptic('selection');
                        setZReportSectionTab(next);
                      }
                    }}
                    className="relative grid grid-cols-3 p-1 rounded-xl bg-slate-200/75 dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800 select-none touch-pan-y isolate"
                  >
                    <div
                      aria-hidden="true"
                      style={{
                        width: 'calc((100% - 8px) / 3)',
                        transform: `translate3d(${
                          (['items', 'cashiers', 'outlays'] as const).indexOf(zReportSectionTab) * 100
                        }%, 0, 0)`,
                        transition: 'transform 260ms cubic-bezier(0.22, 1, 0.36, 1)',
                      }}
                      className="absolute top-1 bottom-1 left-1 bg-indigo-600 rounded-lg shadow-xs pointer-events-none will-change-transform"
                    />
                    {(
                      [
                        {
                          id: 'items',
                          label: `Items Sold (${zReportData.soldItems.length})`,
                        },
                        {
                          id: 'cashiers',
                          label: `Staff (${zReportData.cashiers.length})`,
                        },
                        {
                          id: 'outlays',
                          label: `Expenses (${zReportData.dayOutlayItems.length})`,
                        },
                      ] as const
                    ).map((tab) => {
                      const active = zReportSectionTab === tab.id;
                      return (
                        <button
                          key={tab.id}
                          type="button"
                          onClick={() => {
                            if (zReportSectionTab === tab.id) return;
                            triggerHaptic('selection');
                            setZReportSectionTab(tab.id);
                          }}
                          className={`relative z-10 h-8 rounded-lg text-[11px] font-bold transition-colors whitespace-nowrap cursor-pointer ${
                            active
                              ? 'text-white'
                              : 'text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white'
                          }`}
                        >
                          {tab.label}
                        </button>
                      );
                    })}
                  </div>

                  {/* TAB A: ITEMS SOLD */}
                  {zReportSectionTab === 'items' && (
                    <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800/90 overflow-hidden">
                      {zReportData.soldItems.length === 0 ? (
                        <div className="py-9 px-4 text-center">
                          <p className="text-xs font-bold text-slate-700 dark:text-slate-300">
                            No items sold on {zReportData.dateLabel}
                          </p>
                          <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">
                            Paid bills for this day will show up here automatically.
                          </p>
                        </div>
                      ) : (
                        <>
                          <div className="divide-y divide-slate-100 dark:divide-slate-800/70">
                            {(showAllZItems
                              ? zReportData.soldItems
                              : zReportData.soldItems.slice(0, 8)
                            ).map((it, i) => (
                              <div
                                key={`${it.name}-${i}`}
                                className="px-4 py-3 flex items-center justify-between gap-3 text-xs"
                              >
                                <div className="flex items-center gap-3 min-w-0">
                                  <span className="w-8 h-8 rounded-xl bg-indigo-500/10 dark:bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 font-mono tabular-nums font-extrabold text-[11px] flex items-center justify-center shrink-0">
                                    {it.qty}×
                                  </span>
                                  <div className="min-w-0">
                                    <p className="font-bold text-slate-900 dark:text-white truncate">
                                      {it.name}
                                    </p>
                                    <p className="text-[11px] font-mono tabular-nums text-slate-400 dark:text-slate-500 truncate mt-0.5">
                                      Sell ₹{formatPrice(it.unitSellPrice)} ·{' '}
                                      {it.unitBuyCost > 0
                                        ? `Buy ₹${formatPrice(it.unitBuyCost)}`
                                        : 'No buy price'}
                                    </p>
                                  </div>
                                </div>

                                <div className="text-right font-mono tabular-nums whitespace-nowrap shrink-0">
                                  <p className="font-extrabold text-slate-900 dark:text-white">
                                    ₹{formatPrice(it.revenue)}
                                  </p>
                                  <p
                                    className={`text-[11px] font-bold mt-0.5 ${
                                      it.unitBuyCost <= 0
                                        ? 'text-slate-400 dark:text-slate-500'
                                        : it.profit >= 0
                                        ? 'text-emerald-600 dark:text-emerald-400'
                                        : 'text-rose-600 dark:text-rose-400'
                                    }`}
                                  >
                                    {it.unitBuyCost > 0
                                      ? `${formatSignedMoney(it.profit, true)} profit`
                                      : '₹0 profit'}
                                  </p>
                                </div>
                              </div>
                            ))}
                          </div>

                          {zReportData.soldItems.length > 8 && (
                            <button
                              type="button"
                              onClick={() => {
                                triggerHaptic('selection');
                                setShowAllZItems((prev) => !prev);
                              }}
                              className="w-full py-2.5 text-center text-xs font-bold text-indigo-600 dark:text-indigo-400 bg-slate-50/80 dark:bg-slate-800/40 hover:bg-slate-100 dark:hover:bg-slate-800 border-t border-slate-200/70 dark:border-slate-800 transition-colors cursor-pointer"
                            >
                              {showAllZItems
                                ? 'Show Top 8 Items'
                                : `View All ${zReportData.soldItems.length} Items`}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  )}

                  {/* TAB B: STAFF / CASHIERS */}
                  {zReportSectionTab === 'cashiers' && (
                    <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800/90 overflow-hidden">
                      {zReportData.cashiers.length === 0 ? (
                        <div className="py-9 px-4 text-center">
                          <p className="text-xs font-bold text-slate-700 dark:text-slate-300">
                            No staff bills recorded on {zReportData.dateLabel}
                          </p>
                        </div>
                      ) : (
                        <div className="divide-y divide-slate-100 dark:divide-slate-800/70">
                          {zReportData.cashiers.map((c) => (
                            <div
                              key={c.name}
                              className="px-4 py-3 flex items-center justify-between gap-3 text-xs"
                            >
                              <div className="flex items-center gap-3 min-w-0">
                                <span className="w-8 h-8 rounded-full bg-indigo-500/10 dark:bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 font-bold text-xs flex items-center justify-center shrink-0">
                                  {c.name.slice(0, 1).toUpperCase()}
                                </span>
                                <div className="min-w-0">
                                  <p className="font-bold text-slate-900 dark:text-white truncate">
                                    {c.name}
                                  </p>
                                  <p className="text-[11px] font-mono tabular-nums text-slate-400 dark:text-slate-500 mt-0.5">
                                    {c.bills} {c.bills === 1 ? 'bill' : 'bills'} completed
                                  </p>
                                </div>
                              </div>

                              <div className="text-right font-mono tabular-nums whitespace-nowrap shrink-0">
                                <p className="font-extrabold text-slate-900 dark:text-white">
                                  ₹{formatPrice(c.sales)}
                                </p>
                                <p
                                  className={`text-[11px] font-bold mt-0.5 ${
                                    c.profit >= 0
                                      ? 'text-emerald-600 dark:text-emerald-400'
                                      : 'text-rose-600 dark:text-rose-400'
                                  }`}
                                >
                                  {formatSignedMoney(c.profit, true)} profit
                                </p>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* TAB C: SHOP EXPENSES */}
                  {zReportSectionTab === 'outlays' && (
                    <div className="rounded-2xl bg-white dark:bg-slate-900 border border-slate-200/80 dark:border-slate-800/90 overflow-hidden">
                      {zReportData.dayOutlayItems.length === 0 ? (
                        <div className="py-9 px-4 text-center">
                          <p className="text-xs font-bold text-slate-700 dark:text-slate-300">
                            No shop expenses on {zReportData.dateLabel}
                          </p>
                          <p className="text-[11px] text-slate-400 dark:text-slate-500 mt-1">
                            Any expense added in Other Costs (up to 1:00 AM) is subtracted here.
                          </p>
                        </div>
                      ) : (
                        <div className="divide-y divide-slate-100 dark:divide-slate-800/70">
                          {zReportData.dayOutlayItems.map((exp) => (
                            <div
                              key={exp.id}
                              className="px-4 py-3 flex items-center justify-between gap-3 text-xs"
                            >
                              <div className="min-w-0">
                                <p className="font-bold text-slate-900 dark:text-white truncate">
                                  {exp.title}
                                </p>
                                <p className="text-[11px] font-mono tabular-nums text-slate-400 dark:text-slate-500 mt-0.5 capitalize">
                                  {exp.category} · {exp.time}
                                </p>
                              </div>
                              <span className="font-mono tabular-nums font-extrabold text-rose-600 dark:text-rose-400 shrink-0">
                                -₹{formatPrice(exp.amount)}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* Sticky Bottom Action Bar */}
              <div className="px-4 sm:px-5 py-3.5 border-t border-slate-200/70 dark:border-slate-800/80 bg-white/95 dark:bg-slate-900/95 space-y-2.5 shrink-0">
                {zReportPrinterAlert && !printerState.connected && (
                  <div className="p-3 rounded-2xl bg-amber-500/10 dark:bg-amber-500/15 border border-amber-500/30 flex items-center justify-between gap-2.5">
                    <div className="flex items-center gap-2 min-w-0">
                      <AlertTriangle size={15} className="text-amber-500 shrink-0" />
                      <div className="min-w-0">
                        <p className="text-xs font-extrabold text-slate-900 dark:text-white leading-tight">
                          No Printer Connected
                        </p>
                        <p className="text-[11px] text-slate-500 dark:text-slate-400 truncate mt-0.5">
                          {printerState.error || 'Connect a Bluetooth or USB thermal printer first.'}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1.5 shrink-0">
                      <button
                        type="button"
                        disabled={printerState.connecting}
                        onClick={async () => {
                          triggerHaptic('medium');
                          const connected = await connectRealPrinter();
                          if (connected) {
                            setZReportPrinterAlert(false);
                            triggerHaptic('success');
                          } else {
                            triggerHaptic('error');
                          }
                        }}
                        className="px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-[11px] font-bold transition-colors cursor-pointer whitespace-nowrap"
                      >
                        {printerState.connecting ? 'Pairing...' : 'Pair Printer'}
                      </button>
                      <button
                        type="button"
                        onClick={() => setZReportPrinterAlert(false)}
                        aria-label="Dismiss printer notice"
                        className="p-1.5 rounded-lg text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors cursor-pointer"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  </div>
                )}
                <div className="flex items-center gap-2.5">
                  <button
                    type="button"
                    onClick={handleCopyZReport}
                    className="flex-1 h-11 rounded-2xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold flex items-center justify-center gap-2 shadow-xs active:scale-[0.98] transition-all cursor-pointer whitespace-nowrap"
                  >
                    {copiedZReport ? (
                      <>
                        <Check size={15} />
                        <span>Copied Report!</span>
                      </>
                    ) : (
                      <>
                        <Copy size={15} />
                        <span>Copy Summary</span>
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={handlePrintZReport}
                    disabled={printingZReport && printerState.connected}
                    className="h-11 px-4 rounded-2xl bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 disabled:opacity-60 text-slate-700 dark:text-slate-200 text-xs font-bold flex items-center justify-center gap-1.5 active:scale-[0.98] transition-all cursor-pointer whitespace-nowrap"
                  >
                    <Printer size={15} />
                    <span>
                      {printingZReport && printerState.connected ? 'Printing...' : 'Print'}
                    </span>
                  </button>
                </div>
              </div>
            </motion.div>
          </div>,
          document.body
        )}
    </motion.div>
  );
}



