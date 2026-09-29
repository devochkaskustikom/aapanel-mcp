/**
 * The aaPanel operation catalogue.
 *
 * Each entry describes one panel action: where it lives, what it needs, and —
 * critically for an agent-facing server — whether it mutates state. The
 * read-only gate is driven by `mutates`, so new operations are safe by
 * default: anything not explicitly marked read-only is refused when the
 * server runs in read-only mode.
 */

import { z } from 'zod';

export type Risk = 'read' | 'write' | 'dangerous';

export interface Operation {
  /** Tool name exposed over MCP. */
  name: string;
  title: string;
  description: string;
  /** Route prefix, e.g. `/v2/site`. */
  route: string;
  action: string;
  /** Extra query parameters merged into the URL before signing. */
  query?: Record<string, string>;
  /** POST form fields, as a zod raw shape. */
  params: z.ZodRawShape;
  /**
   * Reshape validated parameters into what the panel actually expects.
   * Needed where the panel's own parameter name differs from the one a model
   * would naturally use.
   */
  mapParams?: (params: Record<string, unknown>) => Record<string, unknown>;
  risk: Risk;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

const page = {
  p: z.coerce.number().int().min(1).default(1).describe('Page number, 1-based.'),
  limit: z.coerce.number().int().min(1).max(1000).default(20).describe('Rows per page.'),
  search: z.string().default('').describe('Substring filter; for site/db lists this is often the site id.'),
};

export const OPERATIONS: Operation[] = [
  // ---------------------------------------------------------------- system
  {
    name: 'panel_system_total',
    title: 'System totals',
    description:
      'Panel version, OS, CPU cores, CPU usage and physical memory totals. Use this first to confirm connectivity and see what the box looks like.',
    route: '/system',
    action: 'GetSystemTotal',
    params: {},
    risk: 'read',
  },
  {
    name: 'panel_disk_info',
    title: 'Disk partitions',
    description:
      'Capacity and inode usage for every mounted partition. Use before any operation that writes large files, uploads a certificate, or imports a database dump.',
    route: '/system',
    action: 'GetDiskInfo',
    params: {},
    risk: 'read',
  },
  {
    name: 'panel_network_status',
    title: 'Live network and load',
    description:
      'Realtime CPU, memory, load average and cumulative network traffic counters.',
    route: '/system',
    action: 'GetNetWork',
    params: {},
    risk: 'read',
  },
  {
    name: 'panel_install_task_count',
    title: 'Pending install tasks',
    description:
      'Number of install/compile tasks still running. Poll this after asking the panel to install software instead of guessing when a long operation finished.',
    route: '/ajax',
    action: 'GetTaskCount',
    params: {},
    risk: 'read',
  },
  {
    name: 'panel_check_update',
    title: 'Check for panel update',
    description: 'Report whether a newer panel release is available. Read-only when called without force.',
    route: '/ajax',
    action: 'UpdatePanel',
    params: {
      check: z.coerce.boolean().default(true).describe('Set true to query the update channel.'),
    },
    risk: 'read',
  },
  {
    name: 'panel_mysql_status',
    title: 'MySQL service status',
    description: 'Installed MySQL version and whether the service is running.',
    route: '/v2/panel/public',
    action: 'get_soft_status',
    query: { name: 'mysql' },
    params: {},
    risk: 'read',
  },

  // ----------------------------------------------------------------- sites
  {
    name: 'site_list',
    title: 'List websites',
    description:
      'All PHP sites with id, domain, root path, remark, expiry and backup count. This is the entry point for any site operation, since most actions need a numeric site id.',
    route: '/v2/data',
    action: 'getData',
    query: { table: 'sites' },
    params: {
      ...page,
      type: z.coerce.number().int().default(-1).describe('Group filter; -1 means all groups.'),
    },
    risk: 'read',
  },
  {
    name: 'site_get',
    title: 'Get one website',
    description:
      'Fetch a single site record by id. Cheaper and more reliable than paging the whole list when the id is already known.',
    route: '/v2/data',
    action: 'getData',
    query: { table: 'sites' },
    params: {
      id: z.coerce.number().int().describe('Website id from site_list.'),
    },
    risk: 'read',
  },
  {
    name: 'site_types',
    title: 'Site groups',
    description: 'Available site groups/classification ids, with id 0 being the default group.',
    route: '/v2/site',
    action: 'get_site_types',
    params: {},
    risk: 'read',
  },
  {
    name: 'site_list_domains',
    title: 'List domains of a site',
    description: 'Every domain bound to a site, including the port each one answers on.',
    route: '/v2/data',
    action: 'getData',
    query: { table: 'domain' },
    params: {
      id: z.coerce.number().int().describe('Website id.'),
    },
    risk: 'read',
    /**
     * The panel addresses this endpoint as `list=<site id>`, and the parameter
     * is mandatory, so the id is always sent under both names.
     */
    mapParams: ({ id, ...rest }) => ({ ...rest, list: String(id) }),
  },
  {
    name: 'site_get_root',
    title: 'Website root path',
    description: 'Absolute root directory of a site, without listing every site.',
    route: '/v2/data',
    action: 'getKey',
    params: {
      table: z.string().default('sites').describe('Table to read from, normally "sites".'),
      key: z.string().default('path').describe('Column to read, normally "path".'),
      id: z.coerce.number().int().describe('Website id.'),
    },
    risk: 'read',
  },
  {
    name: 'site_php_versions',
    title: 'Installed PHP versions',
    description:
      'Every PHP version installed on the panel, with the "00" pseudo-version meaning pure static. Pass one of these versions when creating a site.',
    route: '/v2/site',
    action: 'GetPHPVersion',
    params: {},
    risk: 'read',
  },
  {
    name: 'site_php_version',
    title: 'PHP version of a site',
    description: 'Which PHP version a specific site currently runs.',
    route: '/v2/site',
    action: 'GetSitePHPVersion',
    params: { siteName: z.string().describe('Primary domain of the site.') },
    risk: 'read',
  },
  {
    name: 'site_rewrite_templates',
    title: 'Rewrite templates',
    description: 'Named rewrite rule templates shipped with the panel (wordpress, laravel5, thinkphp, ...).',
    route: '/v2/site',
    action: 'GetRewriteList',
    params: { siteName: z.string().describe('Primary domain of the site.') },
    risk: 'read',
  },
  {
    name: 'site_get_rewrite',
    title: 'Read a rewrite template',
    description: 'Contents of one rewrite template, so a rule can be reviewed before it is applied to a live site.',
    route: '/v2/files',
    action: 'GetFileBody',
    params: {
      path: z
        .string()
        .describe('Absolute template path, e.g. /www/server/panel/rewrite/nginx/wordpress.conf'),
    },
    risk: 'read',
  },
  {
    name: 'site_get_config',
    title: 'Read vhost config',
    description:
      'Raw nginx or apache vhost file for a site. Useful for debugging a 502 or a rewrite that is not taking effect.',
    route: '/v2/files',
    action: 'GetFileBody',
    params: {
      path: z
        .string()
        .describe('Absolute vhost path, e.g. /www/server/panel/vhost/nginx/example.com.conf'),
    },
    risk: 'read',
  },
  {
    name: 'site_get_ssl',
    title: 'SSL status of a site',
    description: 'Whether SSL is deployed for a site, plus certificate subject and expiry when present.',
    route: '/v2/site',
    action: 'GetSSL',
    params: { siteName: z.string().describe('Primary domain of the site.') },
    risk: 'read',
  },
  {
    name: 'site_dir_userini',
    title: 'Anti-cross-site settings',
    description:
      'The .user.ini anti-cross-site protection flag, access-log flag and the current run directory of a site.',
    route: '/v2/site',
    action: 'GetDirUserINI',
    params: {
      id: z.coerce.number().int().describe('Website id.'),
      path: z.string().describe('Website root path, from site_get_root.'),
    },
    risk: 'read',
  },
  {
    name: 'site_delete_check',
    title: 'Preview a site deletion',
    description:
      'What a site deletion would take with it: associated domains, databases, FTP accounts and root directory. Always call this before site_delete so the user can see the blast radius.',
    route: '/v2/site',
    action: 'check_del_data',
    params: {
      id: z.coerce.number().int().describe('Website id to inspect.'),
    },
    risk: 'read',
    // The panel expects a JSON array under `ids`, not a bare id.
    mapParams: ({ id, ...rest }) => ({ ...rest, ids: JSON.stringify([id]) }),
  },
  {
    name: 'ssl_list',
    title: 'List stored certificates',
    description: 'All SSL certificates uploaded to the panel, with the hash needed to deploy one to a site.',
    route: '/v2/ssl_domain',
    action: 'list_ssl_info',
    params: {
      p: z.coerce.number().int().min(1).default(1).describe('Page number, 1-based.'),
      limit: z.coerce.number().int().min(1).max(1000).default(50).describe('Rows per page.'),
    },
    risk: 'read',
  },

  // ------------------------------------------------------------------- dbs
  {
    name: 'db_list',
    title: 'List databases',
    description: 'All MySQL databases known to the panel, with user, access host and size.',
    route: '/v2/data',
    action: 'getData',
    query: { table: 'databases', type: 'MySQL' },
    params: {
      ...page,
    },
    risk: 'read',
  },
  {
    name: 'db_tables',
    title: 'Tables in a database',
    description:
      'Table names, engines, row counts and total size for a database. Use this to confirm a schema landed before pointing an app at it.',
    route: '/v2/database',
    action: 'GetInfo',
    params: { db_name: z.string().describe('Database name.') },
    risk: 'read',
  },
  {
    name: 'db_access_get',
    title: 'Database access rules',
    description: 'Hosts a database user is allowed to connect from, plus its SSL mode.',
    route: '/v2/database',
    action: 'GetDatabaseAccess',
    params: { name: z.string().describe('Database name.') },
    risk: 'read',
  },
  {
    name: 'db_backups',
    title: 'List database backups',
    description: 'Backup files recorded for a database, newest first.',
    route: '/v2/data',
    action: 'getData',
    query: { table: 'backup' },
    params: {
      search: z.coerce.number().int().describe('Database id from db_list.'),
      p: z.coerce.number().int().min(1).default(1).describe('Page number, 1-based.'),
      limit: z.coerce.number().int().min(1).max(500).default(20).describe('Rows per page.'),
      type: z.coerce.number().int().default(1).describe('Backup type: 1 = database.'),
    },
    risk: 'read',
  },
  {
    name: 'db_recycle_bin',
    title: 'Database recycle bin',
    description:
      'Databases that were deleted and can still be restored. Use db_delete_check first: the panel keeps them recoverable.',
    route: '/v2/files',
    action: 'Get_Recycle_bin',
    params: {},
    risk: 'read',
  },
  {
    name: 'db_delete_check',
    title: 'Preview a database deletion',
    description: 'The record the panel would remove, so a deletion can be confirmed against the right database.',
    route: '/v2/database',
    action: 'check_del_data',
    params: { id: z.coerce.number().int().describe('Database id from db_list.') },
    risk: 'read',
    // The panel expects a JSON array under `ids`, not a bare id.
    mapParams: ({ id, ...rest }) => ({ ...rest, ids: JSON.stringify([id]) }),
  },

  // ----------------------------------------------------------------- write
  {
    name: 'site_create',
    title: 'Create a website',
    description:
      'Create a PHP site, optionally with an FTP account and a MySQL database in one call. The panel generates passwords; the response returns them once, so capture them for the user rather than logging them.',
    route: '/v2/site',
    action: 'AddSite',
    params: {
      webname: z
        .string()
        .describe('JSON: {"domain":"example.com","domainlist":[],"count":0}'),
      type: z.string().default('PHP').describe('Project type; "PHP" for a PHP site.'),
      port: z.coerce.number().int().min(1).max(65535).default(80).describe('Web port.'),
      ps: z.string().default('').describe('Human-readable remark shown in the panel.'),
      path: z.string().describe('Absolute root directory, e.g. /www/wwwroot/example.com.'),
      type_id: z.coerce.number().int().default(0).describe('Group id from site_types; 0 is default.'),
      version: z.string().describe('PHP version from site_php_versions, e.g. "82" or "00" for static.'),
      ftp: z.coerce.boolean().default(false).describe('Also create an FTP account.'),
      sql: z.coerce.boolean().default(false).describe('Also create a MySQL database.'),
      ftp_username: z.string().optional().describe('FTP username; required when ftp is true.'),
      ftp_password: z.string().optional().describe('FTP password; required when ftp is true.'),
      datauser: z.string().optional().describe('Database name/user; required when sql is true.'),
      datapassword: z.string().optional().describe('Database password; required when sql is true.'),
      codeing: z.string().default('utf8mb4').describe('Database charset when sql is true.'),
      set_ssl: z.coerce.number().int().default(0).describe('0 = no certificate, 1 = request one.'),
      force_ssl: z.coerce.number().int().default(0).describe('0 = keep HTTP, 1 = force HTTPS redirect.'),
      is_create_default_file: z
        .boolean()
        .default(true)
        .describe('Create the default index page.'),
    },
    risk: 'write',
  },
  {
    name: 'site_delete',
    title: 'Delete a website',
    description:
      'Delete a site. Run site_delete_check first and show the user what would be lost. The panel keeps a recycle bin for some resources, but do not rely on it.',
    route: '/v2/site',
    action: 'DeleteSite',
    params: {
      id: z.coerce.number().int().describe('Website id from site_list.'),
      webname: z.string().describe('Primary domain of the site, used for confirmation.'),
    },
    risk: 'write',
    annotations: { destructiveHint: true },
  },
  {
    name: 'site_start',
    title: 'Start a website',
    description: 'Bring a stopped site back online.',
    route: '/v2/site',
    action: 'SiteStart',
    params: {
      id: z.coerce.number().int().describe('Website id.'),
      name: z.string().describe('Primary domain of the site.'),
    },
    risk: 'write',
  },
  {
    name: 'site_stop',
    title: 'Stop a website',
    description: 'Take a site offline without deleting it.',
    route: '/v2/site',
    action: 'SiteStop',
    params: {
      id: z.coerce.number().int().describe('Website id.'),
      name: z.string().describe('Primary domain of the site.'),
    },
    risk: 'write',
  },
  {
    name: 'site_add_domain',
    title: 'Add a domain',
    description:
      'Bind an extra domain to an existing site. Newline-separated values add several at once. The site name must also be added to DNS.',
    route: '/v2/site',
    action: 'AddDomain',
    params: {
      id: z.coerce.number().int().describe('Website id.'),
      webname: z.string().describe('Primary domain of the site.'),
      domain: z.string().describe('Domain to add, e.g. www.example.com. Omit :80 and separate multiples with newlines.'),
    },
    risk: 'write',
  },
  {
    name: 'site_remove_domain',
    title: 'Remove a domain',
    description: 'Unbind one domain from a site, leaving the site itself intact.',
    route: '/v2/site',
    action: 'DelDomain',
    params: {
      id: z.coerce.number().int().describe('Website id.'),
      webname: z.string().describe('Primary domain of the site.'),
      domain: z.string().describe('Domain to remove.'),
      port: z.coerce.number().int().default(80).describe('Port that domain answers on.'),
    },
    risk: 'write',
    annotations: { destructiveHint: true },
  },
  {
    name: 'site_set_php_version',
    title: 'Change PHP version',
    description:
      'Switch a site to another installed PHP version. Extensions available in one version may be missing in another, so verify afterwards.',
    route: '/v2/site',
    action: 'SetPHPVersion',
    params: {
      siteName: z.string().describe('Primary domain of the site.'),
      version: z.string().describe('Target PHP version from site_php_versions.'),
    },
    risk: 'write',
  },
  {
    name: 'site_set_run_path',
    title: 'Set run directory',
    description:
      'Change the directory nginx resolves requests against, for apps whose entry point lives in a subdirectory such as /public. The directory must already exist inside the site root.',
    route: '/v2/site',
    action: 'SetSiteRunPath',
    params: {
      id: z.coerce.number().int().describe('Website id.'),
      runPath: z.string().describe('Directory relative to the site root, e.g. /public.'),
    },
    risk: 'write',
  },
  {
    name: 'site_set_dir_userini',
    title: 'Toggle anti-cross-site protection',
    description: 'Toggle the .user.ini cross-site protection for a site.',
    route: '/v2/site',
    action: 'SetDirUserINI',
    params: {
      id: z.coerce.number().int().describe('Website id.'),
      path: z.string().describe('Website root path.'),
    },
    risk: 'write',
  },
  {
    name: 'site_set_rewrite',
    title: 'Apply a rewrite rule',
    description:
      'Write the rewrite config for a site and reload nginx. Overwrites the current rule, so read the existing one first when changing something live.',
    route: '/v2/files',
    action: 'SaveFileBody',
    params: {
      path: z.string().describe('Rewrite file path, e.g. /www/server/panel/vhost/rewrite/example.com.conf'),
      data: z.string().describe('Full rewrite config content.'),
      encoding: z.string().default('utf-8').describe('File encoding.'),
    },
    risk: 'write',
  },
  {
    name: 'site_set_index',
    title: 'Set default documents',
    description: 'Change which filenames nginx treats as directory indexes, comma separated.',
    route: '/site',
    action: 'SetIndex',
    params: {
      id: z.coerce.number().int().describe('Website id.'),
      Index: z.string().describe('Comma-separated default documents, e.g. index.php,index.html.'),
    },
    risk: 'write',
  },
  {
    name: 'site_backup',
    title: 'Back up a website',
    description: 'Start a site backup. Poll panel_install_task_count or site_backups to see when it finishes.',
    route: '/site',
    action: 'ToBackup',
    params: { id: z.coerce.number().int().describe('Website id.') },
    risk: 'write',
  },
  {
    name: 'site_list_backups',
    title: 'List website backups',
    description: 'Backup records for a site, newest first.',
    route: '/data',
    action: 'getData',
    query: { table: 'backup' },
    params: {
      search: z.coerce.number().int().describe('Website id.'),
      limit: z.coerce.number().int().min(1).max(500).default(20).describe('Rows per page.'),
      p: z.coerce.number().int().min(1).default(1).describe('Page number, 1-based.'),
      type: z.coerce.number().int().default(0).describe('Backup type: 0 = site.'),
    },
    risk: 'read',
  },
  {
    name: 'db_create',
    title: 'Create a database',
    description:
      'Create a MySQL database and user. Pass 127.0.0.1 as the access host unless the app connects from another machine, in which case pass that machine ip or % for any host.',
    route: '/v2/database',
    action: 'AddDatabase',
    params: {
      name: z.string().describe('Database name.'),
      db_user: z.string().describe('Database user.'),
      password: z.string().describe('Database password.'),
      dataAccess: z.string().default('127.0.0.1').describe('Allowed host: 127.0.0.1, a specific ip, or % for any.'),
      address: z.string().default('127.0.0.1').describe('Access host, same meaning as dataAccess.'),
      codeing: z.string().default('utf8mb4').describe('Database charset.'),
      ps: z.string().default('').describe('Database remark.'),
      sid: z.coerce.number().int().default(0).describe('Associated website id, 0 for none.'),
      active: z.coerce.boolean().default(false).describe('Mark the database active.'),
      ssl: z.string().default('').describe('SSL mode; leave empty for the default.'),
      dtype: z.string().default('MySQL').describe('Database type.'),
    },
    risk: 'write',
  },
  {
    name: 'db_set_password',
    title: 'Change database password',
    description: 'Set a new password for an existing database user. Update the application config in the same change, or the app will lose the database.',
    route: '/v2/database',
    action: 'ResDatabasePassword',
    params: {
      id: z.coerce.number().int().describe('Database id from db_list.'),
      password: z.string().describe('New password.'),
      name: z.string().optional().describe('Database name, for confirmation.'),
    },
    risk: 'write',
  },
  {
    name: 'db_set_access',
    title: 'Set database access',
    description: 'Change which hosts a database user may connect from.',
    route: '/v2/database',
    action: 'SetDatabaseAccess',
    params: {
      name: z.string().describe('Database name.'),
      dataAccess: z.string().default('ip').describe('Mode: "ip" for specific hosts, "all" for any host.'),
      access: z.string().describe('Comma-separated hosts, e.g. 127.0.0.1,1.1.1.1 or %.'),
      ssl: z.string().optional().describe('SSL mode; omit to leave unchanged.'),
    },
    risk: 'write',
  },
  {
    name: 'db_backup',
    title: 'Back up a database',
    description: 'Start a database backup. The result lands in the panel backup directory.',
    route: '/v2/database',
    action: 'ToBackup',
    params: { id: z.coerce.number().int().describe('Database id from db_list.') },
    risk: 'write',
  },
  {
    name: 'db_delete',
    title: 'Delete a database',
    description:
      'Delete a database. The panel moves it to the recycle bin rather than dropping it immediately, but treat it as destructive and confirm with db_delete_check first.',
    route: '/v2/database',
    action: 'DeleteDatabase',
    params: {
      id: z.coerce.number().int().describe('Database id from db_list.'),
      name: z.string().describe('Database name, for confirmation.'),
    },
    risk: 'write',
    annotations: { destructiveHint: true },
  },
  {
    name: 'db_optimize_table',
    title: 'Optimize tables',
    description: 'Run OPTIMIZE TABLE on one or more tables of a database.',
    route: '/v2/database',
    action: 'OpTable',
    params: {
      db_name: z.string().describe('Database name.'),
      tables: z
        .array(z.string())
        .describe('Table names, e.g. ["wp_posts"]. Use db_tables to discover them.'),
    },
    risk: 'write',
  },
  {
    name: 'db_repair_table',
    title: 'Repair tables',
    description: 'Run REPAIR TABLE on one or more tables of a database, for recovering from a crash.',
    route: '/v2/database',
    action: 'ReTable',
    params: {
      db_name: z.string().describe('Database name.'),
      tables: z.array(z.string()).describe('Table names to repair.'),
    },
    risk: 'write',
  },
  {
    name: 'db_sync_from_server',
    title: 'Import server databases into the panel',
    description:
      'Pull databases that exist in MySQL but are not tracked by the panel into the panel inventory. Safe and non-destructive to existing records.',
    route: '/v2/database',
    action: 'SyncGetDatabases',
    params: { sid: z.coerce.number().int().default(0).describe('Website id to bind to, 0 for none.') },
    risk: 'write',
  },
  {
    name: 'db_restore',
    title: 'Restore a database from recycle bin',
    description: 'Restore a deleted database using the rname shown by db_recycle_bin.',
    route: '/v2/files',
    action: 'Re_Recycle_bin',
    params: { path: z.string().describe('Recycle bin rname, e.g. BTDB_shop_t_1756280259.') },
    risk: 'write',
  },
  {
    name: 'db_import_sql',
    title: 'Import a SQL dump',
    description:
      'Import a .sql file that already exists on the panel host into a database. The file must be on the panel machine, not uploaded by this server.',
    route: '/v2/database',
    action: 'InputSql',
    params: {
      name: z.string().describe('Target database name.'),
      file: z.string().describe('Absolute path to the .sql file on the panel host.'),
    },
    risk: 'write',
  },

  // -------------------------------------------------------------------- ssl
  {
    name: 'ssl_upload',
    title: 'Upload a certificate',
    description: 'Store a PEM certificate and private key in the panel. Returns the hash used by ssl_deploy.',
    route: '/v2/ssl_domain',
    action: 'upload_cert',
    params: {
      cert: z.string().describe('PEM certificate content, including BEGIN CERTIFICATE.'),
      key: z.string().describe('PEM private key content, including the key header/footer.'),
    },
    risk: 'write',
  },
  {
    name: 'ssl_deploy',
    title: 'Deploy a certificate to sites',
    description: 'Bind a stored certificate to one or more sites, replacing their current SSL configuration.',
    route: '/v2/ssl_domain',
    action: 'cert_deploy_sites',
    params: {
      hash: z.string().describe('Certificate hash from ssl_list or ssl_upload.'),
      domains: z.array(z.string()).describe('Domains to bind, e.g. ["example.com","www.example.com"].'),
    },
    risk: 'write',
  },
  {
    name: 'ssl_disable',
    title: 'Disable SSL on a site',
    description: 'Remove the SSL configuration from a site, returning it to plain HTTP.',
    route: '/v2/site',
    action: 'CloseSSLConf',
    params: {
      siteName: z.string().describe('Primary domain of the site.'),
      updateOf: z.coerce
        .number()
        .int()
        .default(1)
        .describe('Required by the panel; 1 acknowledges the change.'),
    },
    risk: 'write',
    annotations: { destructiveHint: true },
  },

  // ------------------------------------------------------------- dangerous
  {
    name: 'danger_mysql_root_password',
    title: 'Get or reset the MySQL root password',
    description:
      'Read the MySQL root password, or set a new one when password is supplied. This is the highest-privilege credential on the box: the server refuses to expose it unless AAPANEL_ALLOW_DANGEROUS is set.',
    route: '/v2/data',
    action: 'getKey',
    params: {
      key: z.string().default('mysql_root').describe('Key to read, normally mysql_root.'),
      table: z.string().default('config').describe('Table to read, normally config.'),
      id: z.coerce.number().int().default(1).describe('Config row id.'),
    },
    risk: 'dangerous',
    annotations: { destructiveHint: true },
  },
  {
    name: 'danger_mysql_reset_root_password',
    title: 'Reset the MySQL root password',
    description:
      'Set a new MySQL root password. Every existing root login, cron job and monitoring agent that used the old password will stop working.',
    route: '/v2/database',
    action: 'SetupPassword',
    params: { password: z.string().describe('New MySQL root password.') },
    risk: 'dangerous',
    annotations: { destructiveHint: true },
  },
  {
    name: 'danger_write_file',
    title: 'Write an arbitrary panel file',
    description:
      'Write any file the panel user can write, including vhost and nginx configs. This bypasses every validation in the site tools, so the server refuses it unless AAPANEL_ALLOW_DANGEROUS is set.',
    route: '/v2/files',
    action: 'SaveFileBody',
    params: {
      path: z.string().describe('Absolute file path on the panel host.'),
      data: z.string().describe('Full file content.'),
      encoding: z.string().default('utf-8').describe('File encoding.'),
    },
    risk: 'dangerous',
    annotations: { destructiveHint: true },
  },
  {
    name: 'danger_read_file',
    title: 'Read an arbitrary panel file',
    description:
      'Read any file readable by the panel user, including /www/server/panel/config.json and database files. Refused unless AAPANEL_ALLOW_DANGEROUS is set.',
    route: '/v2/files',
    action: 'GetFileBody',
    params: { path: z.string().describe('Absolute file path on the panel host.') },
    risk: 'dangerous',
  },
  {
    name: 'danger_update_panel',
    title: 'Update the panel itself',
    description: 'Install a panel update. Refused unless AAPANEL_ALLOW_DANGEROUS is set.',
    route: '/ajax',
    action: 'UpdatePanel',
    params: {
      force: z.coerce.boolean().default(true).describe('Set true to actually install the update.'),
    },
    risk: 'dangerous',
    annotations: { destructiveHint: true },
  },
];

/**
 * Keys that must never reach a model, a transcript, or a log file.
 *
 * Matching is done on a lower-cased key, and several spellings of the same
 * secret are listed because aaPanel uses different ones in different places:
 * the v2 `AddSite` response returns `ftpPass` / `databasePass` / `databaseUser`
 * style fields, while request parameters use `ftp_password` / `datapassword`.
 */
const SECRET_KEYS = new Set([
  'password',
  'ftp_password',
  'ftppass',
  'datapassword',
  'databasepass',
  'db_pass',
  'dbpass',
  'mysql_root',
  'mysqlroot',
  'request_token',
  'apikey',
  'api_key',
]);

/** Substrings that mark a key as secret even when the exact name is unknown. */
const SECRET_PATTERNS = [/pass(word|wd)?$/i, /secret/i, /^pw$/i, /token$/i];

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k) ? '***redacted***' : redact(v);
    }
    return out;
  }
  return value;
}

function isSecretKey(key: string): boolean {
  const k = key.toLowerCase();
  return SECRET_KEYS.has(k) || SECRET_PATTERNS.some((p) => p.test(k));
}

/** Redact the request parameters that were sent, for the audit trail. */
export function redactParams(params: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(params)) {
    out[k] = isSecretKey(k) ? '***redacted***' : v;
  }
  return out;
}
