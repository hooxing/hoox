import type { AdminAgentDefinitionList, AgentRevisionContentDto } from "@hoox/protocol";
import { Button, Input, Typography } from "antd";
import { useId, useState } from "react";

export function AgentSkillSelector({
  options,
  value,
  onChange,
}: {
  readonly options: Readonly<AdminAgentDefinitionList["skillOptions"]>;
  readonly value: AgentRevisionContentDto["skillVersions"];
  readonly onChange: (value: AgentRevisionContentDto["skillVersions"]) => void;
}) {
  const inputId = useId();
  const [search, setSearch] = useState("");
  const query = search.trim().toLocaleLowerCase();
  const matches = options.filter((option) =>
    `${option.displayName} ${option.description} ${option.skillId}`
      .toLocaleLowerCase()
      .includes(query),
  );
  return (
    <fieldset className="agent-tool-options">
      <legend>自带 Skill</legend>
      {options.length === 0 ? (
        <Typography.Text type="secondary">
          暂无已发布的 Skill，请前往「Skills」页面发布。
        </Typography.Text>
      ) : (
        <>
          <label className="agent-field" htmlFor={inputId}>
            <span>搜索 Skill</span>
            <Input
              id={inputId}
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="按名称、简介或 ID 搜索"
            />
          </label>
          <ul className="agent-row-list" aria-label="可选 Skill">
            {matches.map((option) => (
              <li key={option.skillId}>
                <strong>{option.displayName}</strong> — {option.description}
                <Button
                  disabled={
                    value.length >= 64 || value.some((item) => item.skillId === option.skillId)
                  }
                  onClick={() => {
                    const version = option.versions[0];
                    if (version !== undefined)
                      onChange([...value, { skillId: option.skillId, version }]);
                  }}
                >
                  添加 {option.displayName}
                </Button>
              </li>
            ))}
          </ul>
          {matches.length === 0 && (
            <Typography.Text type="secondary">没有匹配的 Skill。</Typography.Text>
          )}
        </>
      )}
      <ul className="agent-row-list" aria-label="已选 Skill">
        {value.map((item) => {
          const option = options.find((candidate) => candidate.skillId === item.skillId);
          const name = option?.displayName ?? item.skillId;
          const available = option?.versions.includes(item.version) ?? false;
          return (
            <li key={item.skillId}>
              <strong>{name}</strong>
              {option && <p>{option.description}</p>}
              <label className="agent-field">
                <span>{name} 的版本</span>
                <select
                  value={item.version}
                  onChange={(event) =>
                    onChange(
                      value.map((selected) =>
                        selected.skillId === item.skillId
                          ? { ...selected, version: event.target.value }
                          : selected,
                      ),
                    )
                  }
                >
                  {!available && <option value={item.version}>已不可选：{item.version}</option>}
                  {option?.versions.map((version, index) => (
                    <option key={version} value={version}>
                      {version}
                      {index === 0 ? "（最新已发布）" : ""}
                    </option>
                  ))}
                </select>
              </label>
              {!available && (
                <Typography.Text type="warning">
                  当前精确版本已不可选，请改选可用版本或移除。
                </Typography.Text>
              )}
              <Button
                onClick={() =>
                  onChange(value.filter((selected) => selected.skillId !== item.skillId))
                }
              >
                移除 {name}
              </Button>
            </li>
          );
        })}
      </ul>
      <Typography.Text type="secondary">
        最多选择 64 个 Skill；每个 Skill 固定一个精确版本，新发布不会自动替换。
      </Typography.Text>
    </fieldset>
  );
}
