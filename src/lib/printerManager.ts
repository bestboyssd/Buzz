import { Bill } from './firestoreHooks';
import { formatPrice } from './utils';

export interface PrinterState {
  connected: boolean;
  connecting: boolean;
  deviceName: string | null;
  error: string | null;
}

type Listener = (state: PrinterState) => void;

// Standard BLE / Bluetooth Thermal Printer Service UUIDs (58mm / 80mm ESC/POS)
const THERMAL_PRINTER_SERVICES = [
  '000018f0-0000-1000-8000-00805f9b34fb',
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455',
  '0000ff00-0000-1000-8000-00805f9b34fb',
  '0000ffe0-0000-1000-8000-00805f9b34fb',
];

let activeBluetoothDevice: any = null;
let activeWritableCharacteristic: any = null;
let activeUsbDevice: any = null;

let currentState: PrinterState = {
  connected: false,
  connecting: false,
  deviceName: null,
  error: null,
};

const listeners = new Set<Listener>();

function emitState(patch: Partial<PrinterState>) {
  currentState = { ...currentState, ...patch };
  listeners.forEach((fn) => fn(currentState));
}

export function getPrinterState(): PrinterState {
  // Verify live hardware state on read
  if (activeBluetoothDevice) {
    const isStillConnected = Boolean(activeBluetoothDevice.gatt?.connected);
    if (!isStillConnected && currentState.connected && !activeUsbDevice) {
      activeBluetoothDevice = null;
      activeWritableCharacteristic = null;
      currentState = {
        connected: false,
        connecting: false,
        deviceName: null,
        error: null,
      };
    }
  }
  return currentState;
}

export function subscribePrinterState(listener: Listener): () => void {
  listeners.add(listener);
  listener(getPrinterState());
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Initiates a real hardware connection to a Bluetooth or USB thermal printer.
 * Never fakes a connection: returns true ONLY if an actual physical printer pairs and connects.
 */
export async function connectRealPrinter(): Promise<boolean> {
  if (currentState.connecting) return false;
  emitState({ connecting: true, error: null });

  const nav = navigator as any;

  // 1. Try Web Bluetooth API (Standard for Android / Chrome portable thermal printers)
  if (nav.bluetooth && typeof nav.bluetooth.requestDevice === 'function') {
    try {
      const device = await nav.bluetooth.requestDevice({
        acceptAllDevices: true,
        optionalServices: THERMAL_PRINTER_SERVICES,
      });

      if (!device) {
        emitState({
          connected: false,
          connecting: false,
          deviceName: null,
          error: 'No printer selected',
        });
        return false;
      }

      const handleDisconnect = () => {
        activeBluetoothDevice = null;
        activeWritableCharacteristic = null;
        emitState({
          connected: false,
          connecting: false,
          deviceName: null,
          error: 'Printer disconnected',
        });
      };

      device.addEventListener('gattserverdisconnected', handleDisconnect);

      if (device.gatt) {
        const server = await device.gatt.connect();
        activeBluetoothDevice = device;

        // Attempt to discover writable ESC/POS characteristic if exposed
        try {
          const services = await server.getPrimaryServices();
          for (const service of services) {
            const chars = await service.getCharacteristics();
            for (const c of chars) {
              if (c.properties?.write || c.properties?.writeWithoutResponse) {
                activeWritableCharacteristic = c;
                break;
              }
            }
            if (activeWritableCharacteristic) break;
          }
        } catch {
          // Device connected over GATT even if custom service enumeration is restricted
        }

        emitState({
          connected: true,
          connecting: false,
          deviceName: device.name || 'Bluetooth Printer',
          error: null,
        });
        return true;
      }
    } catch (err: any) {
      const msg = String(err?.message || err || '');
      const isCancelled =
        err?.name === 'NotFoundError' ||
        msg.toLowerCase().includes('cancelled') ||
        msg.toLowerCase().includes('canceled') ||
        msg.toLowerCase().includes('user cancelled');
      const isPolicyBlocked =
        err?.name === 'SecurityError' ||
        msg.toLowerCase().includes('permissions policy') ||
        msg.toLowerCase().includes('disallowed');

      if (isCancelled) {
        emitState({
          connected: false,
          connecting: false,
          deviceName: null,
          error: 'Pairing cancelled',
        });
        return false;
      }

      if (!isPolicyBlocked) {
        emitState({
          connected: false,
          connecting: false,
          deviceName: null,
          error: 'Could not connect to Bluetooth printer',
        });
        return false;
      }
    }
  }

  // 2. Try WebUSB API if available (for USB OTG thermal printers)
  if (nav.usb && typeof nav.usb.requestDevice === 'function') {
    try {
      const usbDevice = await nav.usb.requestDevice({ filters: [] });
      if (usbDevice) {
        await usbDevice.open();
        activeUsbDevice = usbDevice;
        emitState({
          connected: true,
          connecting: false,
          deviceName: usbDevice.productName || 'USB Thermal Printer',
          error: null,
        });
        return true;
      }
    } catch (err: any) {
      const msg = String(err?.message || err || '');
      const isCancelled =
        err?.name === 'NotFoundError' || msg.toLowerCase().includes('no device selected');
      if (isCancelled) {
        emitState({
          connected: false,
          connecting: false,
          deviceName: null,
          error: 'No printer selected',
        });
        return false;
      }
    }
  }

  // 3. Native Android APK Print Spooler fallback (Android System WebView uses OS PrintManager instead of Web Bluetooth)
  const isNativeAndroid =
    typeof window !== 'undefined' &&
    Boolean(
      (window as any).AndroidExporter ||
      (window as any).Capacitor?.isNativePlatform?.()
    );

  if (isNativeAndroid) {
    emitState({
      connected: true,
      connecting: false,
      deviceName: 'Android Print Service',
      error: null,
    });
    return true;
  }

  // Hardware Bluetooth/USB unavailable in this browser/iframe environment
  emitState({
    connected: false,
    connecting: false,
    deviceName: null,
    error: 'Bluetooth unavailable in preview · Open on phone to pair',
  });
  return false;
}

export async function disconnectRealPrinter(): Promise<void> {
  try {
    if (activeBluetoothDevice?.gatt?.connected) {
      activeBluetoothDevice.gatt.disconnect();
    }
  } catch {
    // ignore
  }
  try {
    if (activeUsbDevice) {
      await activeUsbDevice.close();
    }
  } catch {
    // ignore
  }
  activeBluetoothDevice = null;
  activeWritableCharacteristic = null;
  activeUsbDevice = null;
  emitState({
    connected: false,
    connecting: false,
    deviceName: null,
    error: null,
  });
}

/**
 * If a BLE thermal printer with a writable ESC/POS characteristic is connected,
 * streams raw ESC/POS bytes directly to the printer.
 */
export async function sendEscPosToConnectedPrinter(bill: Bill): Promise<boolean> {
  if (!activeWritableCharacteristic) return false;
  try {
    const encoder = new TextEncoder();
    const shortId = bill.id?.slice(-6).toUpperCase() || '000000';
    const d = new Date(bill.date);
    const dateStr = d.toLocaleDateString();
    const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const items = Array.isArray(bill.items) ? bill.items : [];
    const totalUnits = items.reduce((s, i) => s + (Number(i.quantity) || 0), 0);
    const subtotal = items.reduce(
      (s, i) => s + (Number(i.quantity) || 0) * (Number(i.price) || 0),
      0
    );
    const discountAmt = Math.max(0, Number((bill as any).discount) || 0);
    const statusText = bill.isUdhar
      ? 'UDHAR (UNPAID)'
      : bill.status === 'on_hold'
      ? 'ON HOLD'
      : 'PAID';

    const lines: string[] = [
      '\x1B\x40', // Initialize printer
      '\x1B\x61\x01', // Center align
      '\x1B\x45\x01', // Bold ON
      '\x1B\x21\x30', // Double width + height
      'SmartRooti\n',
      '\x1B\x21\x00', // Reset text size
      '\x1B\x45\x00', // Bold OFF
      'OFFICIAL SALES RECEIPT\n',
      '================================\n',
      '\x1B\x61\x00', // Left align
      `Receipt: #${shortId}   [${statusText}]\n`,
      `Date:    ${dateStr} ${timeStr}\n`,
    ];

    if (bill.customerName) {
      lines.push(`Cust:    ${bill.customerName}\n`);
    }
    if (bill.customerPhone) {
      lines.push(`Phone:   ${bill.customerPhone}\n`);
    }

    lines.push('--------------------------------\n');

    items.forEach((item) => {
      const qty = Number(item.quantity) || 0;
      const price = Number(item.price) || 0;
      const lineTotal = formatPrice(qty * price);
      lines.push(`${item.name}\n`);
      lines.push(`  ${qty} x Rs.${formatPrice(price)} = Rs.${lineTotal}\n`);
    });

    lines.push('--------------------------------\n');
    lines.push(`Items: ${items.length} (${totalUnits} units)\n`);
    if (discountAmt > 0) {
      lines.push(`Subtotal:     Rs.${formatPrice(subtotal)}\n`);
      lines.push(`Discount:    -Rs.${formatPrice(discountAmt)}\n`);
    }

    const totalLabel = bill.isUdhar
      ? 'UDHAR DUE'
      : bill.status === 'on_hold'
      ? 'HOLD TOTAL'
      : 'TOTAL PAID';

    lines.push(
      '================================\n',
      '\x1B\x45\x01',
      `${totalLabel}: Rs.${formatPrice(bill.total)}\n`,
      '\x1B\x45\x00',
      '================================\n',
      '\x1B\x61\x01',
      'Thank you for shopping with\nSmartRooti!\n\n\n'
    );

    const payload = encoder.encode(lines.join(''));
    const chunkSize = 180;
    for (let i = 0; i < payload.length; i += chunkSize) {
      const chunk = payload.slice(i, i + chunkSize);
      if (activeWritableCharacteristic.properties?.writeWithoutResponse) {
        await activeWritableCharacteristic.writeValueWithoutResponse(chunk);
      } else {
        await activeWritableCharacteristic.writeValue(chunk);
      }
    }
    return true;
  } catch (e) {
    console.warn('Direct ESC/POS write failed, falling back to system print:', e);
    return false;
  }
}

export async function sendEscPosZReportToConnectedPrinter(zReportData: any): Promise<boolean> {
  if (!activeWritableCharacteristic || !zReportData) return false;
  try {
    const encoder = new TextEncoder();
    const lines: string[] = [
      '\x1B\x40', // Initialize printer
      '\x1B\x61\x01', // Center align
      '\x1B\x45\x01', // Bold ON
      '\x1B\x21\x30', // Double width + height
      'SmartRooti\n',
      '\x1B\x21\x00', // Reset size
      'DAILY Z-REPORT\n',
      '\x1B\x45\x00', // Bold OFF
      `${zReportData.dateLabel}\n`,
      `${zReportData.completedBillsCount > 0 ? `${zReportData.firstBillTime} - ${zReportData.lastBillTime}` : 'No completed bills'}\n`,
      '================================\n',
      '\x1B\x61\x00', // Left align
      `Total Sales:  Rs.${formatPrice(zReportData.grossSales || 0)}\n`,
      `Bills Done:   ${zReportData.completedBillsCount || 0} (${zReportData.totalUnitsSold || 0} items)\n`,
      `Avg Bill:     Rs.${formatPrice(zReportData.avgBillValue || 0)}\n`,
    ];

    if ((zReportData.totalDiscount || 0) > 0) {
      lines.push(`Discounts:   -Rs.${formatPrice(zReportData.totalDiscount)}\n`);
    }

    lines.push(
      `Buy Cost:    -Rs.${formatPrice(zReportData.shiftCogs || 0)}\n`,
      `Shop Costs:  -Rs.${formatPrice(zReportData.dayOtherCosts || 0)}\n`,
      '--------------------------------\n',
      '\x1B\x45\x01',
      `${(zReportData.netShiftProfit || 0) >= 0 ? 'FINAL PROFIT' : 'NET LOSS'}: Rs.${formatPrice(Math.abs(zReportData.netShiftProfit || 0))}\n`,
      `CASH DRAWER:  Rs.${formatPrice(zReportData.expectedCashInDrawer || 0)}\n`,
      '\x1B\x45\x00',
      '================================\n'
    );

    if ((zReportData.udharBillsCount || 0) > 0 || (zReportData.heldBillsCount || 0) > 0) {
      lines.push('PENDING ACCOUNTS:\n');
      if (zReportData.udharBillsCount > 0) {
        lines.push(` Unpaid Udhar (${zReportData.udharBillsCount}): Rs.${formatPrice(zReportData.udharBillsTotal || 0)}\n`);
      }
      if (zReportData.heldBillsCount > 0) {
        lines.push(` On Hold (${zReportData.heldBillsCount}):      Rs.${formatPrice(zReportData.heldBillsTotal || 0)}\n`);
      }
      lines.push('--------------------------------\n');
    }

    if (Array.isArray(zReportData.cashiers) && zReportData.cashiers.length > 0) {
      lines.push('STAFF SUMMARY:\n');
      zReportData.cashiers.forEach((c: any) => {
        lines.push(` ${c.name} (${c.bills}): Rs.${formatPrice(c.sales || 0)}\n`);
      });
      lines.push('--------------------------------\n');
    }

    if (Array.isArray(zReportData.soldItems) && zReportData.soldItems.length > 0) {
      lines.push('ITEMS SOLD:\n');
      zReportData.soldItems.slice(0, 20).forEach((it: any) => {
        lines.push(` ${it.qty}x ${it.name} - Rs.${formatPrice(it.revenue || 0)}\n`);
      });
      lines.push('--------------------------------\n');
    }

    lines.push('\x1B\x61\x01', 'SmartRooti · Shift Closing\nVerified: ______________\n\n\n');

    const payload = encoder.encode(lines.join(''));
    const chunkSize = 180;
    for (let i = 0; i < payload.length; i += chunkSize) {
      const chunk = payload.slice(i, i + chunkSize);
      if (activeWritableCharacteristic.properties?.writeWithoutResponse) {
        await activeWritableCharacteristic.writeValueWithoutResponse(chunk);
      } else {
        await activeWritableCharacteristic.writeValue(chunk);
      }
    }
    return true;
  } catch (e) {
    console.warn('Direct ESC/POS Z-Report write failed, falling back to system print:', e);
    return false;
  }
}

