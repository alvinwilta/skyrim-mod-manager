import type { OrderMod } from '../../../api/types'

export interface VisibleRow {
  mod: OrderMod
  /** 1-based rank in the FULL unfiltered order (backend move position). */
  pos: number
}
