const entityBrand: unique symbol = Symbol("cube-runtime.domain.entity");

/**
 * 非导出的 symbol 使领域实体在包外不可通过对象字面量构造；唯一入口是 create/rehydrate。
 * symbol 属性不可枚举，因此持久化时仍得到普通 JSON 数据。
 */
export type Entity<Kind extends string, Data extends object> = Readonly<Data> & {
  readonly [entityBrand]: Kind;
};

export function sealEntity<Kind extends string, Data extends object>(
  kind: Kind,
  data: Data,
): Entity<Kind, Data> {
  const entity = { ...data } as Data & { [entityBrand]: Kind };
  Object.defineProperty(entity, entityBrand, {
    value: kind,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  return Object.freeze(entity);
}
