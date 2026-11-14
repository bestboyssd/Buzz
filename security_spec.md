# Security Specification for POS Database

This security specification defines the access control policies, data invariants, and threat models for the shared Point of Sale (POS) system.

## 1. Data Invariants

1. **Shared Collections (Multi-User Collaboration)**:
   - **Products (`/products/{productId}`)**: Shared across all accounts. Any authenticated user can read and modify product stock and details to support real-time stock sync and multi-cashier operations.
   - **Bills (`/bills/{billId}`)**: Shared transaction history. Any cashier can log new bills, view past bills, or modify bills placed on hold.
   - **Other Costs (`/other_costs/{costId}`)**: Shared expense tracking. Any authenticated user can log and view shared operational costs.
   - **Activity Logs (`/activity_logs/{logId}`)**: Shared audit log. Writable by all authenticated cashiers to track user actions; readable only by administrators.

2. **Isolated Collections (Individual Settings)**:
   - **User Profiles (`/settings/profile_{uid}`)**: Strictly isolated to the individual user. A user can only read/write their own profile settings unless they are an administrator.
   - **Failed Login Attempts (`/settings/attempts_{uid}`)**: Isolated to the individual user. Writable by the system to log failed attempts, readable/writable by the user or an administrator.
   - **Global System Settings (`/settings/security_status`, `/settings/global_security_message`, `/settings/backup_{timestamp}`)**: Writable only by administrators. Readable by all authenticated users (except backup documents which are admin-only).

---

## 2. The "Dirty Dozen" Payloads (Threat Vectors & Logic Breakers)

| ID | Targeted Collection | Attack Vector | Payload/Action | Expected Result |
|----|---------------------|---------------|----------------|-----------------|
| D1 | `/settings/profile_userB` | Cross-User Profile Read | User A attempts to read User B's profile document. | **PERMISSION_DENIED** |
| D2 | `/settings/profile_userB` | Cross-User Profile Write | User A attempts to overwrite User B's profile displayName. | **PERMISSION_DENIED** |
| D3 | `/settings/profile_userA` | Privilege Escalation | User A attempts to write `role: 'admin'` or `isAdmin: true` into their own profile. | **PERMISSION_DENIED** |
| D4 | `/settings/security_status` | System Security Bypass | A non-admin user attempts to change the `security_status` to disable force-logout. | **PERMISSION_DENIED** |
| D5 | `/settings/backup_123` | Backup Exfiltration | A non-admin user attempts to read or write system backups. | **PERMISSION_DENIED** |
| D6 | `/activity_logs/log_123` | Audit Log Tampering | A cashier attempts to delete or alter a logged activity log. | **PERMISSION_DENIED** |
| D7 | `/activity_logs/log_123` | Audit Log Exfiltration | A non-admin cashier attempts to query or read other users' activity logs. | **PERMISSION_DENIED** |
| D8 | `/products/prod_123` | Unauthorized Product Delete | An unauthenticated (anonymous guest) user attempts to delete a product. | **PERMISSION_DENIED** |
| D9 | `/bills/bill_123` | Unauthorized Bill Injection | An unauthenticated guest attempts to write a fake bill. | **PERMISSION_DENIED** |
| D10 | `/settings/profile_userA` | Shadow Fields Injection | User A attempts to inject unapproved "Ghost Fields" (e.g., `systemVerified: true`) into their profile. | **PERMISSION_DENIED** |
| D11 | `/products/prod_123` | Price Poisoning | A cashier attempts to write a negative price (e.g., `-100`) for a product. | **PERMISSION_DENIED** |
| D12 | `/settings/attempts_userB` | Brute Force Target Tampering | User A attempts to write or reset failed login attempts for User B. | **PERMISSION_DENIED** |

---

## 3. Security Rules Validation Matrix (TDD Cases)

- **Test Case 1**: Unauthenticated requests are completely blocked from reading or writing any document, except creating security alerts under failed logins.
- **Test Case 2**: Authenticated non-admin users can CRUD products, bills, and other costs to enable collaborative billing.
- **Test Case 3**: Authenticated non-admin users CANNOT read or write settings of another user (e.g. `profile_userB`).
- **Test Case 4**: Authenticated non-admin users CANNOT write to global security settings or read backups.
- **Test Case 5**: Administrators can read/write everything to ensure complete system manageability, backups, and user overrides.
