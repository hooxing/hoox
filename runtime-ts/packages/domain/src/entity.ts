class DomainEntityBrand<Kind extends string> {
  private declare readonly entityKind: Kind;

  constructor(kind: Kind) {
    // kind 只用于固定泛型名义类型，领域数据本身仍保持纯 JSON 形状。
    void kind;
  }
}

/**
 * private class 成员提供真正的名义类型：对象展开只保留公开数据字段，会静态丢失实体身份。
 * 领域实体只能由 create/rehydrate 返回，序列化时仍得到普通 JSON 数据。
 */
export type Entity<Kind extends string, Data extends object> = Readonly<Data> &
  DomainEntityBrand<Kind>;

export function sealEntity<Kind extends string, Data extends object>(
  kind: Kind,
  data: Data,
): Entity<Kind, Data> {
  const entity = Object.assign(new DomainEntityBrand(kind), data) as Entity<Kind, Data>;
  return Object.freeze(entity) as Entity<Kind, Data>;
}
