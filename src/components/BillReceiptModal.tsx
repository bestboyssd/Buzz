import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useNavigate } from 'react-router-dom';
import {
  X,
  Trash2,
  Edit2,
  Printer,
  CheckCircle2,
  ChevronDown,
  Receipt,
  AlertTriangle,
  PauseCircle,
  User,
  Phone,
  Link2,
  Check,
} from 'lucide-react';
import { useCart } from '../lib/CartContext';
import {
  Bill,
  Product,
  deleteBillAndRestoreStock,
  logActivity,
  putBillOnHold,
  saveBillUdhaarDetails,
  settleHoldBill,
} from '../lib/firestoreHooks';
import { useAuth } from '../lib/AuthContext';
import { triggerHaptic } from '../lib/haptics';
import { formatPrice } from '../lib/utils';
import {
  PrinterState,
  getPrinterState,
  subscribePrinterState,
  connectRealPrinter,
  sendEscPosToConnectedPrinter,
} from '../lib/printerManager';

interface BillReceiptModalProps {
  selectedBill: Bill;
  onClose: () => void;
  products: Product[];
}

const formatDateToDMY = (timestamp: number | string | Date) => {
  const d = new Date(timestamp);
  if (isNaN(d.getTime())) return '';
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}/${month}/${year}`;
};

/**
 * Triggers a clean, isolated 58mm/80mm thermal receipt print job using an
 * offscreen iframe (with automatic fallback to window.print()).
 */
function triggerIsolatedThermalPrint(bill: Bill): boolean {
  try {
    const existingFrame = document.getElementById('smartpos-print-iframe') as HTMLIFrameElement | null;
    if (existingFrame && existingFrame.parentNode) {
      existingFrame.parentNode.removeChild(existingFrame);
    }

    const iframe = document.createElement('iframe');
    iframe.id = 'smartpos-print-iframe';
    iframe.style.position = 'fixed';
    iframe.style.right = '0';
    iframe.style.bottom = '0';
    iframe.style.width = '1px';
    iframe.style.height = '1px';
    iframe.style.border = '0';
    iframe.style.opacity = '0.01';
    iframe.style.pointerEvents = 'none';
    document.body.appendChild(iframe);

    const dateStr = formatDateToDMY(bill.date);
    const timeStr = new Date(bill.date).toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit',
    });
    const shortId = bill.id?.slice(-6).toUpperCase() || '000000';
    const items = Array.isArray(bill.items) ? bill.items : [];
    const totalUnits = items.reduce((sum, i) => sum + (Number(i.quantity) || 0), 0);

    const rowsHtml = items
      .map((item) => {
        const qty = Number(item.quantity) || 0;
        const price = Number(item.price) || 0;
        const lineTotal = formatPrice(qty * price);
        const safeName = String(item.name || 'Item')
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
        return `
          <tr>
            <td class="item-name">
              <div>${safeName}</div>
              <div class="item-sub">₹${formatPrice(price)} each</div>
            </td>
            <td class="item-qty">${qty}</td>
            <td class="item-amt">₹${lineTotal}</td>
          </tr>
        `;
      })
      .join('');

    const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Receipt #${shortId}</title>
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
      font-size: 18px;
      font-weight: 800;
      letter-spacing: 0.5px;
    }
    .sub {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 1px;
      margin-top: 2px;
    }
    .meta {
      font-size: 11px;
      padding-bottom: 8px;
      border-bottom: 1px dashed #000;
      margin-bottom: 8px;
    }
    .meta-row {
      display: flex;
      justify-content: space-between;
      margin-bottom: 2px;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-bottom: 8px;
    }
    th {
      font-size: 10px;
      text-transform: uppercase;
      border-bottom: 1px dashed #000;
      padding-bottom: 4px;
      text-align: left;
    }
    th.qty { text-align: center; width: 36px; }
    th.amt { text-align: right; width: 72px; }
    td {
      padding: 5px 0;
      vertical-align: top;
      border-bottom: 1px dotted #ccc;
    }
    td.item-name {
      font-weight: 600;
      padding-right: 6px;
      word-break: break-word;
    }
    .item-sub {
      font-size: 10px;
      font-weight: 400;
      color: #333;
    }
    td.item-qty {
      text-align: center;
      font-weight: 600;
    }
    td.item-amt {
      text-align: right;
      font-weight: 700;
      white-space: nowrap;
    }
    .totals {
      border-top: 1px dashed #000;
      padding-top: 6px;
      margin-top: 4px;
    }
    .total-row {
      display: flex;
      justify-content: space-between;
      font-size: 11px;
      margin-bottom: 3px;
    }
    .grand-total {
      display: flex;
      justify-content: space-between;
      font-size: 15px;
      font-weight: 800;
      border-top: 1px solid #000;
      border-bottom: 1px dashed #000;
      padding: 6px 0;
      margin-top: 4px;
    }
    .footer {
      text-align: center;
      font-size: 10px;
      margin-top: 12px;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="brand">SMART POS</div>
    <div class="sub">Official Sales Receipt</div>
  </div>
  <div class="meta">
    <div class="meta-row"><span>Receipt No:</span><strong>#${shortId}</strong></div>
    <div class="meta-row"><span>Date:</span><span>${dateStr} ${timeStr}</span></div>
    <div class="meta-row"><span>Status:</span><strong>${bill.isUdhar ? 'UDHAR (UNPAID)' : bill.status === 'on_hold' ? 'ON HOLD' : 'PAID'}</strong></div>
    ${bill.isUdhar && bill.customerName ? `<div class="meta-row"><span>Customer:</span><strong>${String(bill.customerName).replace(/</g, '&lt;')}</strong></div>` : ''}
    ${bill.isUdhar && bill.customerPhone ? `<div class="meta-row"><span>Phone:</span><span>${String(bill.customerPhone).replace(/</g, '&lt;')}</span></div>` : ''}
    <div class="meta-row"><span>Items:</span><span>${items.length} (${totalUnits} units)</span></div>
  </div>
  <table>
    <thead>
      <tr>
        <th>Item</th>
        <th class="qty">Qty</th>
        <th class="amt">Total</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml}
    </tbody>
  </table>
  <div class="totals">
    <div class="total-row">
      <span>Total Qty</span>
      <span>${totalUnits} units</span>
    </div>
    <div class="grand-total">
      <span>${bill.isUdhar ? 'UDHAR DUE' : 'TOTAL PAID'}</span>
      <span>₹${formatPrice(bill.total)}</span>
    </div>
  </div>
  <div class="footer">
    <div>Thank you for your business!</div>
  </div>
</body>
</html>`;

    const androidBridge = typeof window !== 'undefined' ? (window as any).AndroidExporter : null;
    if (androidBridge && typeof androidBridge.printHtml === 'function') {
      try {
        if (iframe.parentNode) {
          iframe.parentNode.removeChild(iframe);
        }
        return Boolean(androidBridge.printHtml(`Receipt_${shortId}`, html));
      } catch (e) {
        console.warn('Android native print bridge fallback:', e);
      }
    }

    const doc = iframe.contentWindow?.document || iframe.contentDocument;
    if (!doc || !iframe.contentWindow) {
      window.print();
      return true;
    }

    doc.open();
    doc.write(html);
    doc.close();

    // Invoke print immediately while user gesture activation is active
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
    console.warn('Iframe print fallback to window.print():', err);
    try {
      window.print();
      return true;
    } catch {
      return false;
    }
  }
}

export function BillReceiptModal({
  selectedBill,
  onClose,
  products,
}: BillReceiptModalProps) {
  const [confirming, setConfirming] = useState(false);
  const [printStage, setPrintStage] = useState<
    'idle' | 'disconnected' | 'formatting' | 'dispatched'
  >('idle');
  const [reprintCount, setReprintCount] = useState(0);
  const [showHelp, setShowHelp] = useState(false);
  const [actionError, setActionError] = useState('');
  const [printerState, setPrinterState] = useState<PrinterState>(() =>
    getPrinterState()
  );
  const [liveBill, setLiveBill] = useState<Bill>(selectedBill);
  const [editingUdhaar, setEditingUdhaar] = useState(false);
  const [customerName, setCustomerName] = useState(
    selectedBill.customerName === 'Walk-in Customer' ? '' : selectedBill.customerName || ''
  );
  const [customerPhone, setCustomerPhone] = useState(selectedBill.customerPhone || '');
  const [udhaarNote, setUdhaarNote] = useState(selectedBill.udhaarNote || '');
  const [savingUdhaar, setSavingUdhaar] = useState(false);
  const { setCart, setEditingBill } = useCart();
  const navigate = useNavigate();
  const { user } = useAuth();
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    setLiveBill(selectedBill);
    setCustomerName(
      selectedBill.customerName === 'Walk-in Customer' ? '' : selectedBill.customerName || ''
    );
    setCustomerPhone(selectedBill.customerPhone || '');
    setUdhaarNote(selectedBill.udhaarNote || '');
  }, [selectedBill]);

  const handleSaveUdhaar = async () => {
    if (savingUdhaar) return;
    const trimmedName = customerName.trim();
    if (!trimmedName) {
      triggerHaptic('error');
      setActionError('Customer name is required to put a bill on Udhar.');
      return;
    }
    setActionError('');
    setSavingUdhaar(true);
    triggerHaptic('medium');
    try {
      const updated = await saveBillUdhaarDetails(
        liveBill,
        {
          isHold: true,
          customerName: trimmedName,
          customerPhone: customerPhone.trim(),
          udhaarNote: udhaarNote.trim(),
          linkToOtherCosts: true,
          costCategory: 'borrow',
        },
        user?.uid
      );
      setLiveBill(updated);
      setEditingUdhaar(false);
      triggerHaptic('success');
    } catch (e: any) {
      setActionError(e.message || 'Could not update Udhar details.');
    } finally {
      setSavingUdhaar(false);
    }
  };

  const handleSettleBill = async () => {
    if (savingUdhaar) return;
    setSavingUdhaar(true);
    triggerHaptic('heavy');
    try {
      const settled = await settleHoldBill(liveBill);
      setLiveBill(settled);
      setCustomerName('');
      setCustomerPhone('');
      setUdhaarNote('');
      setEditingUdhaar(false);
      triggerHaptic('success');
    } catch (e: any) {
      setActionError(e.message || 'Could not settle bill.');
    } finally {
      setSavingUdhaar(false);
    }
  };

  useEffect(() => {
    const unsub = subscribePrinterState((state) => {
      setPrinterState(state);
    });
    const handleAndroidBack = (e: Event) => {
      e.preventDefault();
      onClose();
    };
    window.addEventListener('androidBackPress', handleAndroidBack);
    return () => {
      unsub();
      window.removeEventListener('androidBackPress', handleAndroidBack);
      if (timerRef.current) window.clearTimeout(timerRef.current);
    };
  }, [onClose]);

  const startThermalPrintSequence = () => {
    const livePrinter = getPrinterState();
    if (!livePrinter.connected) {
      setPrintStage('disconnected');
      return;
    }
    setReprintCount((c) => c + 1);
    setPrintStage('formatting');
    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(async () => {
      if (!getPrinterState().connected) {
        setPrintStage('disconnected');
        return;
      }
      triggerHaptic('success');
      setPrintStage('dispatched');
      const sentDirect = await sendEscPosToConnectedPrinter(selectedBill);
      if (!sentDirect) {
        triggerIsolatedThermalPrint(selectedBill);
      }
    }, 550);
  };

  const handlePrintAgain = async () => {
    if (printStage === 'formatting') return;
    if (!getPrinterState().connected) {
      triggerHaptic('error');
      setPrintStage('disconnected');
      return;
    }
    triggerHaptic('heavy');
    setReprintCount((c) => c + 1);
    setPrintStage('formatting');

    // Trigger print / ESC-POS dispatch and replay formatting animation
    const sentDirect = await sendEscPosToConnectedPrinter(selectedBill);
    if (!sentDirect) {
      triggerIsolatedThermalPrint(selectedBill);
    }

    if (timerRef.current) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      triggerHaptic('success');
      setPrintStage('dispatched');
    }, 500);
  };

  const handlePrint = () => {
    if (printStage === 'formatting') return;
    triggerHaptic('heavy');

    if (!getPrinterState().connected) {
      triggerHaptic('error');
      setPrintStage('disconnected');
      return;
    }

    startThermalPrintSequence();
  };

  const handleDelete = () => {
    if (!selectedBill.id) return;
    triggerHaptic('success');

    deleteBillAndRestoreStock(selectedBill.id, selectedBill.items).catch((err) => {
      console.error('Failed to delete bill in background:', err);
    });

    if (user) {
      logActivity(
        'delete_bill',
        `Deleted transaction bill #${selectedBill.id} (Total: ₹${formatPrice(selectedBill.total)}). Restored items to stock.`,
        user.uid,
        user.displayName || 'User',
        user.email || ''
      ).catch((err) => console.error('Failed to log delete activity:', err));
    }
    onClose();
  };

  const handleEdit = () => {
    if (!selectedBill.id) return;
    triggerHaptic('medium');

    try {
      putBillOnHold(selectedBill.id, selectedBill.items, selectedBill.status).catch((err) => {
        console.error('Failed to put bill on hold in background:', err);
      });

      const newCart = (selectedBill.items || []).map((item) => {
        const product = products.find((p) => p.id === item.productId);
        const safePrice = Number(item.price ?? product?.price) || 0;
        const productData: Product = product
          ? { ...product, price: safePrice }
          : {
              id: item.productId || `deleted_${Date.now()}`,
              name: item.name || 'Restored Item',
              price: safePrice,
              stock: 0,
              createdAt: Date.now(),
              category: 'Other',
            };
        return { product: productData, quantity: Math.max(1, Number(item.quantity) || 1) };
      });

      if (user) {
        logActivity(
          'edit_bill',
          `Initiated edit of transaction bill #${selectedBill.id} (Total: ₹${formatPrice(selectedBill.total)}). Bill placed on hold.`,
          user.uid,
          user.displayName || 'User',
          user.email || ''
        ).catch((err) => console.error('Failed to log edit activity:', err));
      }

      setCart(newCart);
      setEditingBill(selectedBill);
      onClose();
      navigate('/');
    } catch (e: any) {
      console.error('Failed to edit bill:', e);
      setActionError(e.message || 'Failed to edit bill. Please try again.');
    }
  };

  const shortId = selectedBill.id?.slice(-6).toUpperCase() || '000000';
  const totalUnits = (selectedBill.items || []).reduce(
    (sum, item) => sum + (Number(item.quantity) || 0),
    0
  );

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 receipt-print-portal">
      {/* Backdrop */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.2 }}
        onClick={onClose}
        className="absolute inset-0 bg-slate-950/60 dark:bg-slate-950/75 backdrop-blur-md no-print"
      />

      {/* Modal Container */}
      <motion.div
        initial={{ scale: 0.92, opacity: 0, y: 16 }}
        animate={{ scale: 1, opacity: 1, y: 0 }}
        exit={{ scale: 0.92, opacity: 0, y: 12 }}
        transition={{ type: 'spring', stiffness: 380, damping: 30, mass: 0.8 }}
        className="w-full max-w-md bg-white dark:bg-[#151822] border border-slate-200/90 dark:border-white/[0.08] shadow-2xl relative z-10 max-h-[90vh] overflow-hidden flex flex-col rounded-[2rem] no-print"
      >
        {/* Top Modal Bar */}
        <div className="px-5 pt-5 pb-3.5 flex justify-between items-center border-b border-slate-100 dark:border-white/[0.06] shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-indigo-50 dark:bg-indigo-500/15 flex items-center justify-center text-indigo-600 dark:text-indigo-400">
              <Receipt size={18} />
            </div>
            <div>
              <h2 className="text-base font-extrabold text-slate-900 dark:text-slate-100 leading-tight">
                Receipt Details
              </h2>
              <p className="text-[11px] font-mono tabular-nums text-slate-500 dark:text-slate-400">
                #{shortId} · {totalUnits} {totalUnits === 1 ? 'unit' : 'units'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => {
              triggerHaptic('light');
              onClose();
            }}
            aria-label="Close receipt details"
            className="w-9 h-9 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800/80 dark:hover:bg-slate-700 rounded-full flex items-center justify-center text-slate-500 dark:text-slate-400 transition-colors cursor-pointer"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body Content: Switches cleanly between Receipt View and Thermal Print Stage */}
        <div className="flex-1 overflow-y-auto p-5 flex flex-col">
          <AnimatePresence mode="wait">
            {printStage === 'disconnected' ? (
              <motion.div
                key="printer-disconnected-stage"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.2 }}
                className="py-6 flex flex-col items-center justify-center text-center"
              >
                <div className="w-14 h-14 rounded-2xl bg-amber-500/12 dark:bg-amber-500/15 border border-amber-500/25 flex items-center justify-center text-amber-500 mb-4">
                  <AlertTriangle size={28} />
                </div>
                <h3 className="text-base font-extrabold text-slate-900 dark:text-white">
                  No Thermal Printer Connected
                </h3>
                <p className="text-xs text-slate-500 dark:text-slate-400 max-w-xs mt-1 mb-5 leading-relaxed">
                  {printerState.error
                    ? printerState.error
                    : `Connect a physical Bluetooth or USB thermal printer before printing receipt #${shortId}.`}
                </p>
                <div className="flex flex-col gap-2.5 w-full max-w-xs">
                  <button
                    type="button"
                    disabled={printerState.connecting}
                    onClick={async () => {
                      triggerHaptic('medium');
                      const ok = await connectRealPrinter();
                      if (ok) {
                        triggerHaptic('success');
                        startThermalPrintSequence();
                      } else {
                        triggerHaptic('error');
                      }
                    }}
                    className="w-full py-3 bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white rounded-xl text-xs font-bold shadow-sm shadow-indigo-600/20 transition-colors cursor-pointer"
                  >
                    {printerState.connecting
                      ? 'Searching for Printer...'
                      : 'Pair Bluetooth / USB Printer'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('light');
                      setPrintStage('idle');
                    }}
                    className="w-full py-2.5 bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 rounded-xl text-xs font-bold transition-colors cursor-pointer"
                  >
                    Back to Receipt
                  </button>
                </div>
              </motion.div>
            ) : printStage !== 'idle' ? (
              <motion.div
                key="thermal-print-stage"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                transition={{ duration: 0.22 }}
                className="py-4 flex flex-col items-center justify-center text-center"
              >
                {/* Realistic Animated Thermal Printer & Sliding Ticket */}
                <div className="w-full max-w-[260px] mx-auto mb-5 flex flex-col items-center">
                  {/* Printer Head Slot */}
                  <div className="w-full h-7 rounded-t-2xl bg-slate-800 dark:bg-slate-700 px-4 flex items-center justify-between shadow-md relative z-20">
                    <div className="flex items-center gap-1.5">
                      <span
                        className={`w-2 h-2 rounded-full ${
                          printStage === 'formatting' ? 'bg-amber-400' : 'bg-emerald-400'
                        }`}
                      />
                      <span className="text-[10px] font-mono font-bold text-slate-300 uppercase tracking-wider">
                        80mm Thermal
                      </span>
                    </div>
                    <Printer size={13} className="text-slate-300" />
                  </div>
                  <div className="w-[94%] h-2 bg-slate-950 rounded-b-md relative z-20 shadow-inner" />

                  {/* Sliding Paper Ticket */}
                  <div className="w-[88%] overflow-hidden -mt-1 relative z-10">
                    <motion.div
                      key={`ticket-slip-${reprintCount}`}
                      initial={{ y: -90, opacity: 0.4 }}
                      animate={{ y: 0, opacity: 1 }}
                      transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
                      className="bg-amber-50/70 dark:bg-slate-900 border-x border-b border-slate-200 dark:border-slate-700/80 rounded-b-2xl p-4 shadow-md text-left font-mono"
                    >
                      <div className="text-center border-b border-dashed border-slate-300 dark:border-slate-700 pb-2 mb-2.5">
                        <p className="text-xs font-extrabold text-slate-900 dark:text-white tracking-wider">
                          SMART POS
                        </p>
                        <p className="text-[10px] text-slate-500 dark:text-slate-400">
                          #{shortId} · {formatDateToDMY(selectedBill.date)}
                        </p>
                      </div>
                      <div className="space-y-1.5 mb-2.5">
                        {(selectedBill.items || []).slice(0, 3).map((it, i) => (
                          <div
                            key={i}
                            className="flex justify-between text-[11px] text-slate-700 dark:text-slate-300"
                          >
                            <span className="truncate pr-2">
                              {it.quantity}× {it.name}
                            </span>
                            <span className="font-bold shrink-0">
                              ₹{formatPrice((Number(it.quantity) || 0) * (Number(it.price) || 0))}
                            </span>
                          </div>
                        ))}
                        {(selectedBill.items || []).length > 3 && (
                          <p className="text-[10px] text-slate-400">
                            +{(selectedBill.items || []).length - 3} more items
                          </p>
                        )}
                      </div>
                      <div className="border-t border-dashed border-slate-300 dark:border-slate-700 pt-2 flex justify-between items-baseline">
                        <span className="text-[10px] font-bold uppercase text-slate-500 dark:text-slate-400">
                          Total
                        </span>
                        <span className="text-sm font-extrabold text-indigo-600 dark:text-indigo-400">
                          ₹{formatPrice(selectedBill.total)}
                        </span>
                      </div>
                    </motion.div>
                  </div>
                </div>

                {/* Progress & Status Copy */}
                {printStage === 'formatting' ? (
                  <div className="w-full max-w-xs space-y-2.5">
                    <div className="w-full h-1.5 bg-slate-100 dark:bg-slate-800 rounded-full overflow-hidden">
                      <motion.div
                        initial={{ width: '15%' }}
                        animate={{ width: '100%' }}
                        transition={{ duration: 0.45, ease: 'easeInOut' }}
                        className="h-full bg-indigo-600 dark:bg-indigo-400 rounded-full"
                      />
                    </div>
                    <h3 className="text-base font-extrabold text-slate-900 dark:text-white">
                      Formatting Thermal Receipt...
                    </h3>
                    <p className="text-xs text-slate-500 dark:text-slate-400">
                      Building 58mm / 80mm ticket slip for #{shortId}
                    </p>
                  </div>
                ) : (
                  <motion.div
                    initial={{ opacity: 0, scale: 0.96 }}
                    animate={{ opacity: 1, scale: 1 }}
                    className="w-full space-y-4"
                  >
                    <div className="inline-flex items-center gap-1.5 text-emerald-600 dark:text-emerald-400 text-xs font-extrabold">
                      <CheckCircle2 size={16} />
                      <span>Print Dialog Ready</span>
                    </div>
                    <p className="text-xs text-slate-500 dark:text-slate-400 max-w-xs mx-auto leading-relaxed">
                      Select your paired Bluetooth / USB thermal printer or Save as PDF in the system print prompt.
                    </p>
                    <div className="flex items-center gap-2.5 pt-1">
                      <button
                        type="button"
                        onClick={handlePrintAgain}
                        className="flex-1 py-2.5 px-4 rounded-xl bg-slate-100 hover:bg-slate-200 dark:bg-slate-800 dark:hover:bg-slate-700 active:scale-95 text-slate-800 dark:text-slate-200 text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer"
                      >
                        <Printer size={14} />
                        <span>Print Again</span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic('light');
                          setPrintStage('idle');
                        }}
                        className="flex-1 py-2.5 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-700 active:scale-95 text-white text-xs font-bold transition-all cursor-pointer"
                      >
                        Back to Receipt
                      </button>
                    </div>
                  </motion.div>
                )}
              </motion.div>
            ) : (
              <motion.div
                key="receipt-details-stage"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15 }}
                className="flex flex-col flex-1"
              >
                {actionError && (
                  <div className="mb-4 p-3 rounded-xl bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/20 text-red-600 dark:text-red-400 text-xs font-semibold flex items-center justify-between">
                    <span>{actionError}</span>
                    <button
                      type="button"
                      onClick={() => setActionError('')}
                      className="text-xs font-bold underline ml-2"
                    >
                      Dismiss
                    </button>
                  </div>
                )}

                {/* Crisp Paper Receipt Preview Card */}
                <div className="rounded-2xl bg-slate-50/90 dark:bg-slate-900/80 border border-slate-200/80 dark:border-white/[0.07] p-4 mb-3.5">
                  <div className="text-center pb-3.5 mb-3.5 border-b border-dashed border-slate-200 dark:border-slate-800">
                    <div className="flex items-center justify-center gap-1.5 mb-1">
                      <span
                        className={`px-2 py-0.5 rounded-md text-[10px] font-extrabold uppercase tracking-wider ${
                          liveBill.isUdhar
                            ? 'bg-amber-500/15 text-amber-600 dark:text-amber-400 border border-amber-500/25'
                            : liveBill.status === 'on_hold'
                            ? 'bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 border border-indigo-500/25'
                            : 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400'
                        }`}
                      >
                        {liveBill.isUdhar
                          ? 'Udhar (Unpaid)'
                          : liveBill.status === 'on_hold'
                          ? 'On Hold'
                          : 'Total Paid'}
                      </span>
                      {liveBill.linkedOtherCostId && (
                        <span className="px-2 py-0.5 rounded-md text-[10px] font-bold bg-indigo-500/12 text-indigo-600 dark:text-indigo-400">
                          Linked to Other Costs
                        </span>
                      )}
                    </div>
                    <p
                      className={`text-3xl font-extrabold font-mono tabular-nums tracking-tight mt-0.5 ${
                        liveBill.isUdhar
                          ? 'text-amber-600 dark:text-amber-400'
                          : 'text-slate-900 dark:text-white'
                      }`}
                    >
                      ₹{formatPrice(liveBill.total)}
                    </p>
                    <p className="text-xs text-slate-500 dark:text-slate-400 font-mono tabular-nums mt-1.5">
                      {formatDateToDMY(liveBill.date)} ·{' '}
                      {new Date(liveBill.date).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </p>

                    {Boolean(liveBill.isUdhar) &&
                      (liveBill.customerName || liveBill.customerPhone || liveBill.udhaarNote) && (
                        <div className="mt-3 pt-2.5 border-t border-slate-200/70 dark:border-slate-800/80 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs">
                          {liveBill.customerName && (
                            <span className="inline-flex items-center gap-1 font-bold text-slate-800 dark:text-slate-200">
                              <User size={12} className="text-amber-500" />
                              {liveBill.customerName}
                            </span>
                          )}
                          {liveBill.customerPhone && (
                            <a
                              href={`tel:${liveBill.customerPhone}`}
                              className="inline-flex items-center gap-1 font-mono font-bold text-indigo-600 dark:text-indigo-400 hover:underline"
                            >
                              <Phone size={12} />
                              {liveBill.customerPhone}
                            </a>
                          )}
                          {liveBill.udhaarNote && (
                            <span className="w-full text-[11px] text-slate-500 dark:text-slate-400 italic">
                              "{liveBill.udhaarNote}"
                            </span>
                          )}
                        </div>
                      )}
                  </div>

                  {/* Line Items */}
                  <div className="space-y-2.5 max-h-44 overflow-y-auto pr-0.5">
                    {(liveBill.items || []).map((item, idx) => (
                      <div
                        key={idx}
                        className="flex justify-between items-start gap-3 text-xs py-1 border-b border-slate-200/50 dark:border-white/[0.04] last:border-b-0"
                      >
                        <div className="min-w-0">
                          <p className="font-bold text-slate-900 dark:text-slate-100 truncate">
                            {item.name}
                          </p>
                          <p className="text-[11px] text-slate-500 dark:text-slate-400 font-mono tabular-nums mt-0.5">
                            {item.quantity} × ₹{formatPrice(item.price)}
                          </p>
                        </div>
                        <span className="font-mono tabular-nums font-bold text-slate-900 dark:text-slate-100 shrink-0">
                          ₹{formatPrice((Number(item.quantity) || 0) * (Number(item.price) || 0))}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Put on Udhar Customer Details Panel */}
                <div className="mb-3.5">
                  {editingUdhaar ? (
                    <div className="p-3.5 rounded-2xl bg-amber-50/70 dark:bg-amber-500/10 border border-amber-200/80 dark:border-amber-500/25 space-y-2.5">
                      <div className="flex items-center justify-between">
                        <span className="text-xs font-extrabold text-amber-800 dark:text-amber-300 flex items-center gap-1.5">
                          <User size={14} />
                          Customer Udhar Details
                        </span>
                        <button
                          type="button"
                          onClick={() => setEditingUdhaar(false)}
                          className="text-[11px] font-bold text-slate-500 hover:text-slate-700 dark:text-slate-400"
                        >
                          Cancel
                        </button>
                      </div>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <input
                          type="text"
                          required
                          value={customerName}
                          onChange={(e) => {
                            setCustomerName(e.target.value);
                            if (actionError) setActionError('');
                          }}
                          placeholder="Customer Name (Required)"
                          className="px-3 py-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs font-bold text-slate-900 dark:text-white"
                        />
                        <input
                          type="tel"
                          value={customerPhone}
                          onChange={(e) =>
                            setCustomerPhone(e.target.value.replace(/[^0-9+\-\s]/g, ''))
                          }
                          placeholder="Phone Number"
                          className="px-3 py-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs font-mono font-bold text-slate-900 dark:text-white"
                        />
                      </div>
                      <input
                        type="text"
                        value={udhaarNote}
                        onChange={(e) => setUdhaarNote(e.target.value)}
                        placeholder="Optional note (e.g. promised date)"
                        className="w-full px-3 py-2 rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 text-xs font-medium text-slate-900 dark:text-white"
                      />
                      <button
                        type="button"
                        disabled={savingUdhaar}
                        onClick={handleSaveUdhaar}
                        className="w-full py-2.5 rounded-xl bg-amber-500 hover:bg-amber-600 text-white text-xs font-extrabold transition-colors cursor-pointer"
                      >
                        {savingUdhaar ? 'Saving...' : 'Save Udhar'}
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => {
                          triggerHaptic('selection');
                          setEditingUdhaar(true);
                        }}
                        className="flex-1 py-2 px-3 rounded-xl bg-amber-500/12 hover:bg-amber-500/20 text-amber-700 dark:text-amber-300 border border-amber-500/25 text-xs font-bold flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                      >
                        <User size={14} />
                        <span>
                          {liveBill.isUdhar ? 'Edit Udhar' : 'Put on Udhar'}
                        </span>
                      </button>
                      {liveBill.isUdhar && (
                        <button
                          type="button"
                          disabled={savingUdhaar}
                          onClick={handleSettleBill}
                          className="flex-1 py-2 px-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold flex items-center justify-center gap-1.5 shadow-xs transition-colors cursor-pointer"
                        >
                          <Check size={14} />
                          <span>Settle Udhar</span>
                        </button>
                      )}
                    </div>
                  )}
                </div>

                {/* Expandable Bluetooth/Thermal Printer Guide */}
                <div className="mb-4">
                  <button
                    type="button"
                    onClick={() => {
                      triggerHaptic('light');
                      setShowHelp(!showHelp);
                    }}
                    className="w-full flex items-center justify-between text-left text-xs font-bold text-indigo-600 dark:text-indigo-400 py-1.5 px-1 cursor-pointer"
                  >
                    <span>How to print to a Bluetooth / Thermal Printer?</span>
                    <ChevronDown
                      size={15}
                      className={`transition-transform duration-200 ${
                        showHelp ? 'rotate-180' : ''
                      }`}
                    />
                  </button>
                  <AnimatePresence>
                    {showHelp && (
                      <motion.div
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={{ height: 0, opacity: 0 }}
                        className="overflow-hidden mt-1 text-[11px] text-slate-500 dark:text-slate-400 leading-relaxed bg-slate-50 dark:bg-slate-900/90 p-3 rounded-xl border border-slate-200/60 dark:border-slate-800 space-y-1.5"
                      >
                        <p className="font-bold text-slate-700 dark:text-slate-300">
                          58mm / 80mm Thermal Printer Setup:
                        </p>
                        <ol className="list-decimal pl-4 space-y-1">
                          <li>Pair your Bluetooth thermal printer in phone Settings.</li>
                          <li>
                            Install a print service plugin such as{' '}
                            <strong className="text-indigo-600 dark:text-indigo-400">RawBT</strong>{' '}
                            or{' '}
                            <strong className="text-indigo-600 dark:text-indigo-400">
                              Thermal Print Service
                            </strong>
                            .
                          </li>
                          <li>
                            Tap <strong>Print</strong> below and select your printer from the
                            system dialog.
                          </li>
                        </ol>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {/* Action Footer */}
                {confirming ? (
                  <div className="mt-auto pt-3 border-t border-red-500/20 text-center">
                    <p className="mb-3 text-xs font-bold text-red-600 dark:text-red-400">
                      Delete this bill and restore items to stock?
                    </p>
                    <div className="grid grid-cols-2 gap-2.5">
                      <button
                        type="button"
                        onClick={() => setConfirming(false)}
                        className="py-2.5 rounded-xl text-slate-700 dark:text-slate-300 bg-slate-100 dark:bg-slate-800 hover:bg-slate-200 dark:hover:bg-slate-700 text-xs font-bold transition-colors cursor-pointer"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        onClick={handleDelete}
                        className="py-2.5 rounded-xl text-white bg-red-600 hover:bg-red-700 text-xs font-bold transition-colors shadow-sm shadow-red-600/20 cursor-pointer"
                      >
                        Confirm Delete
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="mt-auto grid grid-cols-3 gap-2.5 pt-2">
                    <button
                      type="button"
                      onClick={handleEdit}
                      className="flex items-center justify-center gap-1.5 py-3 rounded-xl text-indigo-600 dark:text-indigo-400 bg-indigo-50 dark:bg-indigo-500/15 hover:bg-indigo-100 dark:hover:bg-indigo-500/25 text-xs font-bold transition-colors cursor-pointer active:scale-95"
                    >
                      <Edit2 size={15} />
                      <span>Edit</span>
                    </button>
                    <button
                      type="button"
                      onClick={handlePrint}
                      className="flex items-center justify-center gap-1.5 py-3 rounded-xl text-white bg-indigo-600 hover:bg-indigo-700 text-xs font-bold transition-colors shadow-sm shadow-indigo-600/25 cursor-pointer active:scale-95"
                    >
                      <Printer size={15} />
                      <span>Print</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        triggerHaptic('medium');
                        setConfirming(true);
                      }}
                      className="flex items-center justify-center gap-1.5 py-3 rounded-xl text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/15 hover:bg-red-100 dark:hover:bg-red-500/25 text-xs font-bold transition-colors cursor-pointer active:scale-95"
                    >
                      <Trash2 size={15} />
                      <span>Delete</span>
                    </button>
                  </div>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>

      {/* Fallback Print-Only DOM Node for environments that invoke window.print() directly */}
      <div className="hidden print-only text-black bg-white p-4 font-mono w-full max-w-[300px] mx-auto text-sm">
        <div className="text-center font-bold text-xl mb-1">SMART POS</div>
        <div className="text-center text-xs mb-4">Official Sales Receipt</div>

        <div className="text-xs mb-4 border-b border-black pb-2 border-dashed">
          <div>Date: {new Date(selectedBill.date).toLocaleString()}</div>
          <div>Receipt No: #{shortId}</div>
        </div>

        <div className="mb-4">
          <div className="flex font-bold text-xs border-b border-black pb-1 mb-2 border-dashed">
            <div className="flex-1">Item</div>
            <div className="w-10 text-center">Qty</div>
            <div className="w-16 text-right">Amount</div>
          </div>
          {(selectedBill.items || []).map((item, idx) => (
            <div key={idx} className="flex text-xs mb-1">
              <div className="flex-1 pr-1 truncate">{item.name}</div>
              <div className="w-10 text-center">{item.quantity}</div>
              <div className="w-16 text-right">
                {((Number(item.quantity) || 0) * (Number(item.price) || 0)).toFixed(2)}
              </div>
            </div>
          ))}
        </div>

        <div className="flex font-bold border-t border-black pt-2 border-dashed text-sm">
          <div className="flex-1 text-right pr-2">TOTAL PAID:</div>
          <div>₹{(Number(selectedBill.total) || 0).toFixed(2)}</div>
        </div>

        <div className="text-center text-xs mt-6 pb-4">Thank you for your business!</div>
      </div>
    </div>
  );
}
