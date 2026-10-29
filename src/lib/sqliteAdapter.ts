import { Capacitor } from "@capacitor/core";
import {
  CapacitorSQLite,
  SQLiteConnection,
  SQLiteDBConnection,
} from "@capacitor-community/sqlite";
import Dexie, { type Table } from "dexie";
import { Product } from "./ProductsContext";
import { Bill } from "./firestoreHooks";

// Web IndexedDB Fallback for browser/preview environments
class WebDatabase extends Dexie {
  products!: Table<Product, string>;
  bills!: Table<Bill, string>;

  constructor() {
    super("buzz_local_cache");
    this.version(1).stores({
      products: "id, name, price, stock, category, createdAt, soldCount",
      bills: "id, total, date, status",
    });
  }
}

const webDb = new WebDatabase();

let sqliteConn: SQLiteConnection | null = null;
let dbInstance: SQLiteDBConnection | null = null;
let isInitialized = false;
let initPromise: Promise<void> | null = null;

const DB_NAME = "buzz_local_cache";

/**
 * Initialize SQLite database on Android/iOS native platform,
 * or setup fallback IndexedDB on web/preview.
 * Guarded with a 1200ms timeout so native bridge locks can never stall UI operations.
 */
export async function initSQLiteCache(): Promise<void> {
  if (isInitialized) return;
  if (initPromise) return initPromise;

  const rawInit = (async () => {
    try {
      if (Capacitor.isNativePlatform()) {
        sqliteConn = new SQLiteConnection(CapacitorSQLite);
        const retCC = (await sqliteConn.checkConnectionsConsistency()).result;
        const isConn = (await sqliteConn.isConnection(DB_NAME, false)).result;

        if (retCC && isConn) {
          dbInstance = await sqliteConn.retrieveConnection(DB_NAME, false);
        } else {
          dbInstance = await sqliteConn.createConnection(
            DB_NAME,
            false,
            "no-encryption",
            1,
            false
          );
        }

        await dbInstance.open();

        // Create products and bills tables
        const createSchemaQuery = `
          CREATE TABLE IF NOT EXISTS products (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            price REAL NOT NULL,
            stock INTEGER NOT NULL,
            category TEXT,
            image TEXT,
            createdAt INTEGER,
            soldCount INTEGER,
            syncedAt INTEGER
          );
          CREATE TABLE IF NOT EXISTS bills (
            id TEXT PRIMARY KEY,
            items TEXT NOT NULL,
            total REAL NOT NULL,
            date INTEGER NOT NULL,
            status TEXT,
            syncedAt INTEGER
          );
        `;
        await dbInstance.execute(createSchemaQuery);
        console.log("Capacitor SQLite database initialized successfully on native platform");
      } else {
        await webDb.open();
        console.log("Local database cache initialized (Web/IndexedDB mode)");
      }
      isInitialized = true;
    } catch (err) {
      console.warn("SQLite initialization warning (using resilient Web fallback):", err);
      isInitialized = true;
    }
  })();

  initPromise = Promise.race([
    rawInit,
    new Promise<void>((resolve) =>
      setTimeout(() => {
        isInitialized = true;
        resolve();
      }, 1200)
    ),
  ]);

  return initPromise;
}

/**
 * Clear all products from local SQLite / IndexedDB cache
 */
export async function sqliteClearProducts(): Promise<void> {
  try {
    localStorage.setItem("local_products_fallback", "[]");
  } catch (_) {}

  await initSQLiteCache();
  try {
    if (Capacitor.isNativePlatform() && dbInstance) {
      await dbInstance.execute(`DELETE FROM products;`);
    } else {
      await webDb.products.clear();
    }
  } catch (err) {
    console.warn("Failed clearing products from SQLite cache:", err);
  }
}

/**
 * Cache all products locally in SQLite database (mirroring exact active catalog)
 */
export async function sqliteSaveProducts(products: Product[]): Promise<void> {
  const safeProducts = Array.isArray(products) ? products.filter((p) => Boolean(p && p.id)) : [];

  // Always update localStorage first so synchronous reads see the exact catalog
  try {
    localStorage.setItem("local_products_fallback", JSON.stringify(safeProducts));
  } catch (_) {}

  await initSQLiteCache();

  try {
    if (Capacitor.isNativePlatform() && dbInstance) {
      await dbInstance.execute(`DELETE FROM products;`);
      if (safeProducts.length > 0) {
        const statements: string[] = [];
        const values: any[] = [];

        for (const p of safeProducts) {
          if (!p.id) continue;
          const img = typeof p.image === "string" ? p.image : "";
          statements.push(
            `INSERT OR REPLACE INTO products (id, name, price, stock, category, image, createdAt, soldCount, syncedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`
          );
          values.push([
            p.id,
            p.name || "",
            Number(p.price) || 0,
            Number(p.stock) || 0,
            p.category || "fresh",
            img,
            Number(p.createdAt) || Date.now(),
            Number(p.soldCount) || 0,
            Date.now(),
          ]);
        }

        await dbInstance.executeSet(
          statements.map((stmt, idx) => ({
            statement: stmt,
            values: values[idx],
          }))
        );
      }
    } else {
      await webDb.products.clear();
      if (safeProducts.length > 0) {
        await webDb.products.bulkPut(safeProducts);
      }
    }
  } catch (err) {
    console.warn("Failed saving products to SQLite cache:", err);
  }
}

/**
 * Save or update a single product in local SQLite
 */
export async function sqliteSaveProduct(product: Product): Promise<void> {
  await initSQLiteCache();
  if (!product.id) return;

  try {
    let mergedProduct: Product = product;
    if (!product.name || product.price === undefined) {
      try {
        const existingWeb = !Capacitor.isNativePlatform()
          ? await webDb.products.get(product.id)
          : undefined;
        if (existingWeb) {
          mergedProduct = { ...existingWeb, ...product };
        } else {
          const raw = localStorage.getItem("local_products_fallback");
          if (raw) {
            const arr = JSON.parse(raw);
            if (Array.isArray(arr)) {
              const found = arr.find((p: any) => p && p.id === product.id);
              if (found) {
                mergedProduct = { ...found, ...product };
              }
            }
          }
        }
      } catch {}
    }

    if (Capacitor.isNativePlatform() && dbInstance) {
      const img = typeof mergedProduct.image === "string" ? mergedProduct.image : "";
      const query = `INSERT OR REPLACE INTO products (id, name, price, stock, category, image, createdAt, soldCount, syncedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`;
      await dbInstance.run(query, [
        mergedProduct.id,
        mergedProduct.name || "",
        Number(mergedProduct.price) || 0,
        Number(mergedProduct.stock) || 0,
        mergedProduct.category || "fresh",
        img,
        Number(mergedProduct.createdAt) || Date.now(),
        Number(mergedProduct.soldCount) || 0,
        Date.now(),
      ]);
    } else {
      await webDb.products.put(mergedProduct);
    }
  } catch (err) {
    console.warn("Failed saving single product to SQLite cache:", err);
  }
}

/**
 * Remove product from local SQLite cache
 */
export async function sqliteDeleteProduct(id: string): Promise<void> {
  await initSQLiteCache();
  if (!id) return;

  try {
    if (Capacitor.isNativePlatform() && dbInstance) {
      await dbInstance.run(`DELETE FROM products WHERE id = ?;`, [id]);
    } else {
      await webDb.products.delete(id);
    }
  } catch (err) {
    console.warn("Failed deleting product from SQLite cache:", err);
  }
}

/**
 * Retrieve cached products from SQLite
 */
export async function sqliteGetProducts(): Promise<Product[]> {
  await initSQLiteCache();

  try {
    if (Capacitor.isNativePlatform() && dbInstance) {
      const res = await dbInstance.query(`SELECT * FROM products ORDER BY soldCount DESC, createdAt DESC;`);
      if (res.values && res.values.length > 0) {
        return res.values as Product[];
      }
    } else {
      const items = await webDb.products.toArray();
      if (items && items.length > 0) {
        return items;
      }
    }
  } catch (err) {
    console.warn("Failed reading products from SQLite cache:", err);
  }

  // Fallback to localStorage
  try {
    const cached = localStorage.getItem("local_products_fallback");
    if (cached) return JSON.parse(cached);
  } catch (_) {}

  return [];
}

/**
 * Clear all bills from local SQLite / IndexedDB cache
 */
export async function sqliteClearBills(): Promise<void> {
  try {
    localStorage.setItem("local_bills_fallback", "[]");
  } catch (_) {}

  await initSQLiteCache();
  try {
    if (Capacitor.isNativePlatform() && dbInstance) {
      await dbInstance.execute(`DELETE FROM bills;`);
    } else {
      await webDb.bills.clear();
    }
  } catch (err) {
    console.warn("Failed clearing bills from SQLite cache:", err);
  }
}

/**
 * Cache all bills locally in SQLite database
 */
export async function sqliteSaveBills(bills: Bill[]): Promise<void> {
  const safeBills = Array.isArray(bills) ? bills.filter((b) => Boolean(b && b.id)) : [];

  try {
    localStorage.setItem("local_bills_fallback", JSON.stringify(safeBills.slice(0, 60)));
  } catch (_) {}

  await initSQLiteCache();

  try {
    if (Capacitor.isNativePlatform() && dbInstance) {
      await dbInstance.execute(`DELETE FROM bills;`);
      if (safeBills.length > 0) {
        const set = safeBills.map((b) => ({
          statement: `INSERT OR REPLACE INTO bills (id, items, total, date, status, syncedAt) VALUES (?, ?, ?, ?, ?, ?);`,
          values: [
            b.id!,
            JSON.stringify(b.items || []),
            Number(b.total) || 0,
            Number(b.date) || Date.now(),
            b.status || "completed",
            Date.now(),
          ],
        }));

        await dbInstance.executeSet(set);
      }
    } else {
      await webDb.bills.clear();
      if (safeBills.length > 0) {
        await webDb.bills.bulkPut(safeBills);
      }
    }
  } catch (err) {
    console.warn("Failed saving bills to SQLite cache:", err);
  }
}

/**
 * Save single bill in local SQLite
 */
export async function sqliteSaveBill(bill: Bill): Promise<void> {
  await initSQLiteCache();
  if (!bill.id) return;

  try {
    if (Capacitor.isNativePlatform() && dbInstance) {
      const query = `INSERT OR REPLACE INTO bills (id, items, total, date, status, syncedAt) VALUES (?, ?, ?, ?, ?, ?);`;
      await dbInstance.run(query, [
        bill.id,
        JSON.stringify(bill.items || []),
        Number(bill.total) || 0,
        Number(bill.date) || Date.now(),
        bill.status || "completed",
        Date.now(),
      ]);
    } else {
      await webDb.bills.put(bill);
    }
  } catch (err) {
    console.warn("Failed saving single bill to SQLite cache:", err);
  }
}

/**
 * Delete a single bill from local SQLite cache
 */
export async function sqliteDeleteBill(billId: string): Promise<void> {
  await initSQLiteCache();
  if (!billId) return;

  try {
    if (Capacitor.isNativePlatform() && dbInstance) {
      const query = `DELETE FROM bills WHERE id = ?;`;
      await dbInstance.run(query, [billId]);
    } else {
      await webDb.bills.delete(billId);
    }
  } catch (err) {
    console.warn("Failed deleting bill from SQLite cache:", err);
  }
}

/**
 * Retrieve cached bills from SQLite
 */
export async function sqliteGetBills(): Promise<Bill[]> {
  await initSQLiteCache();

  try {
    if (Capacitor.isNativePlatform() && dbInstance) {
      const res = await dbInstance.query(`SELECT * FROM bills ORDER BY date DESC;`);
      if (res.values && res.values.length > 0) {
        return res.values.map((v: any) => ({
          ...v,
          items: typeof v.items === "string" ? JSON.parse(v.items) : v.items,
        })) as Bill[];
      }
    } else {
      const items = await webDb.bills.toArray();
      if (items && items.length > 0) {
        return items;
      }
    }
  } catch (err) {
    console.warn("Failed reading bills from SQLite cache:", err);
  }

  try {
    const cached = localStorage.getItem("local_bills_fallback");
    if (cached) return JSON.parse(cached);
  } catch (_) {}

  return [];
}
