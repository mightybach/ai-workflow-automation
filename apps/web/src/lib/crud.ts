/**
 * Client-side integration seam, not an HTTP or database contract.
 * Map your approved API to these operations when it is ready.
 */
export interface CrudStore<TRecord, TCreate, TUpdate = TCreate> {
  list(): Promise<TRecord[]>;
  read(id: string): Promise<TRecord>;
  create(input: TCreate): Promise<TRecord>;
  update(id: string, input: TUpdate): Promise<TRecord>;
  delete(id: string): Promise<void>;
}

