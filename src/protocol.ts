/** Path segment the Service Worker intercepts: `<scope>__bulkexp-zip__/<id>/<name>`. */
export const SW_PREFIX = '__bulkexp-zip__'

/** OPFS folder holding in-progress and finished exports. */
export const OPFS_DIR = 'bulkexp-zip'

/** Web Lock name held while an OPFS export is being written. */
export const lockName = (id: string) => `bulkexp-zip:${id}`
