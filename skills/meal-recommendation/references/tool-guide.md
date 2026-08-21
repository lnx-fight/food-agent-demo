# 下一餐推荐 Tool 使用指南

> 本文件定义 `meal-recommendation` Skill 内部的 Tool 选择、依赖关系和调用编排。
>
> 本文件只在当前任务已经进入 `meal-recommendation` Skill 后使用。
>
> 下一餐推荐中的场景判断与分流由 `SKILL.md` 负责。
>
> 推荐候选的过滤、排序和降级由 `recommendation-rules.md` 负责。
>
> 营养数据的查询、匹配和可信度由 `nutrition-data.md` 负责。
>
> 餐厅、菜单和高德数据的可信边界由 `amap-api.md` 负责。
>
> 单个 Tool 的具体能力、参数和返回结构，以运行时 Tool Description 为准。
>
> 本文件只回答：
>
> **“当前已经知道要完成哪一种下一餐推荐后，需要哪些 Tool，以及这些 Tool 应如何衔接？”**

---

## 1. 使用原则

### 1.1 先使用已有信息，再决定是否调用 Tool

优先使用当前已经存在的：

* 当前对话信息；
* 系统上下文；
* 用户状态；
* 已有 Tool 返回结果。

如果完成当前推荐所需要的信息已经存在，不为了固定流程重复调用 Tool。

例如：

当前上下文已经包含：

* 当前餐次；
* 当前餐次预算；
* 今日已摄入；
* 用户偏好；

则不需要为了“完整流程”再次调用 `read_user_state` 或 `get_meal_budget`。

---

### 1.2 Tool 调用应服务于当前已经确定的推荐场景

`SKILL.md` 负责判断当前属于：

* 在家 DIY；
* 附近餐厅 / 到店；
* 场景未明确。

本文件不重新进行场景判断。

只有在具体场景已经明确后，才进入对应 Tool 链路。

---

### 1.3 场景未明确时，不提前进入具体 Tool 链路

例如用户只说：

> “中午吃什么？”

如果当前没有：

* 在家 / 自己做 / 现有食材等 DIY 信号；
* 附近 / 出去吃 / 到店 / 商圈位置等餐厅信号；

则按照 `SKILL.md`：

> 返回 `open_meal_choice`。

此时不要提前调用：

* `compose_diy_recipe`；
* `search_nearby_restaurants`；
* `get_restaurant_menu`；
* `personalize_restaurant`。

也不要为了提前生成具体推荐，无必要地先计算某个 DIY 或餐厅方案。

用户选择场景后，再进入对应 Tool 链路。

---

## 2. 本 Skill 使用的主要 Tool

| Tool                        | 在本 Skill 中的作用                    |
| --------------------------- | -------------------------------- |
| `read_user_state`           | 在当前上下文缺少必要状态时，读取用户档案、今日摄入和当前目标   |
| `get_meal_budget`           | 在缺少当前目标餐次预算，或餐次 / 日期发生变化时获取对应预算  |
| `get_memory`                | 在历史偏好或近期反馈会明显影响本次推荐时读取近期记忆       |
| `compose_diy_recipe`        | 根据用户真实现有食材生成 DIY 食谱，并返回确定性营养计算结果 |
| `search_nutrition`          | 必要时查询某个具体食材或菜品的营养信息              |
| `search_nearby_restaurants` | 根据坐标或城市 / 商圈搜索真实餐厅候选             |
| `get_restaurant_menu`       | 对真实餐厅候选获取并核验可用菜单 / 菜品信息          |
| `personalize_restaurant`    | 根据当前用户状态和约束，对餐厅 / 菜品候选进行个性化处理    |

本文件不负责非下一餐推荐任务中的 Tool 编排。

例如：

* 饮食记录；
* 修改待确认记录；
* 体重记录；
* 整日饮食计划；

不在本文件定义。

---

## 3. 用户状态与餐次预算

### 3.1 `read_user_state`

只有当当前上下文缺少完成推荐所需的用户状态时才调用。

可能需要的信息包括：

* 当前目标；
* 今日已摄入；
* 饮食偏好；
* 其他会影响本次推荐的当前状态。

如果这些信息已经存在于当前系统上下文或先前 Tool 结果中：

> 不重复调用 `read_user_state`。

---

### 3.2 `get_meal_budget`

当当前推荐需要餐次预算，但上下文中没有对应的可靠预算时调用。

例如：

* 当前上下文没有本餐预算；
* 用户从午餐切换到晚餐；
* 用户从今天切换到明天；
* 当前预算对应的餐次与用户实际请求不一致。

调用时使用实际需要规划的餐次。

已经存在由系统或 Tool 返回的当前餐次预算时：

> 直接使用已有结果，不重新调用，也不自行重新计算。

---

### 3.3 `get_memory`

`get_memory` 不是下一餐推荐的必调 Tool。

只有历史信息可能明显影响当前推荐时调用，例如：

* 用户近期多次明确不喜欢某种食物；
* 最近确认餐食会影响避免重复；
* 用户明确说“按照我之前的习惯推荐”；
* 当前推荐需要使用近期饮食反馈。

如果当前对话或系统上下文已经包含相关偏好：

> 不为了“个性化”形式感额外读取 Memory。

---

## 4. 在家 DIY Tool 链路

当前场景已经由 `SKILL.md` 判断为：

> 在家 DIY

之后进入本节。

### 4.1 前置条件

进入具体 DIY 生成前，应具备：

* 当前需要规划的餐次；
* 用户真实可用的主要食材；
* 当前推荐所需的营养 / 预算信息。

烹饪时间、厨具等信息只有在明显影响结果时才需要补充。

不要为了收集完整资料而进行不必要追问。

---

### 4.2 默认调用链路

优先使用已有上下文。

缺少必要状态时：

```text
read_user_state
```

缺少当前餐次预算时：

```text
get_meal_budget
```

历史偏好确实影响推荐时，可选：

```text
get_memory
```

然后：

```text
compose_diy_recipe
```

因此完整链路可能是：

```text
已有上下文
↓
read_user_state（仅缺必要状态时）
↓
get_meal_budget（仅缺当前餐次预算时）
↓
get_memory（可选）
↓
compose_diy_recipe
```

前面的 Tool 都是条件调用，不要求每轮全部执行。

---

### 4.3 `compose_diy_recipe`

调用 `compose_diy_recipe` 时：

* `ingredients` 必须来自用户真实提供或当前系统已经确认存在的食材；
* 不为了生成更完整的食谱自行补造用户拥有的关键食材；
* 已知餐次时传入正确 `mealType`；
* 已知烹饪时间和厨具时可以一并传入。

`compose_diy_recipe` 已经返回服务器根据数据库计算的食谱营养结果时：

> 直接使用 Tool 返回的结果。

不要为了“验证一下”默认再次调用 `search_nutrition` 重新计算同一份食谱。

---

### 4.4 `search_nutrition` 在 DIY 中的使用

`search_nutrition` 不是 DIY 默认链路中的必调 Tool。

只有出现以下情况时再调用：

* 需要独立核对某个具体食材的营养；
* 当前食谱流程存在无法可靠匹配的具体食材；
* 用户额外询问某个具体食材 / 菜品的营养信息；
* 当前已有结果不足以支撑推荐判断。

营养数据是否可以使用，以及结果如何解释，按 `nutrition-data.md` 执行。

---

### 4.5 DIY 场景不要调用餐厅 Tool

已经进入 DIY 场景后，无新的用户意图变化时，不调用：

* `search_nearby_restaurants`；
* `get_restaurant_menu`；
* `personalize_restaurant`。

如果用户随后明确改成：

> “算了，还是出去吃吧。”

则交回 `SKILL.md` 按新的餐厅场景继续执行。

---

## 5. 附近餐厅 / 到店 Tool 链路

当前场景已经由 `SKILL.md` 判断为：

> 附近餐厅 / 到店

之后进入本节。

### 5.1 前置条件

餐厅搜索至少需要一种可用位置信息：

* latitude + longitude；
* 或可用于定位的城市 / 商圈 / 地址 `area`。

如果当前上下文已经存在有效位置：

> 直接使用。

如果既没有坐标，也没有可用的城市 / 商圈 / 地址：

> 先让用户提供必要位置，或返回对应餐厅入口让用户补充位置。

不要假装已经完成附近搜索。

---

## 5.2 默认调用链路

优先使用已有上下文。

缺少必要用户状态时：

```text
read_user_state
```

缺少当前餐次预算时：

```text
get_meal_budget
```

历史偏好会明显影响推荐时，可选：

```text
get_memory
```

然后进入餐厅主链：

```text
search_nearby_restaurants
↓
get_restaurant_menu
↓
personalize_restaurant
```

完整链路可能是：

```text
已有上下文
↓
read_user_state（仅缺必要状态时）
↓
get_meal_budget（仅缺当前餐次预算时）
↓
get_memory（可选）
↓
search_nearby_restaurants
↓
get_restaurant_menu
↓
personalize_restaurant
```

---

## 5.3 `search_nearby_restaurants`

当当前已有：

* 经纬度；

或：

* 城市 / 商圈 / 地址；

即可按 Tool Description 提供对应参数进行搜索。

如果提供 `area`，允许 Tool 根据当前能力完成位置转换后再搜索。

不要因为缺少经纬度，但已经有可用 `area`，再次询问用户相同位置信息。

搜索获得的结果只代表真实餐厅候选。

餐厅 POI 数据具体能够证明什么，按 `amap-api.md` 执行。

---

## 5.4 已经有真实餐厅时，可以跳过搜索

如果当前上下文中已经存在本轮之前通过可靠 Tool 获得的具体餐厅对象，并且用户明确是在继续讨论这家餐厅，例如：

> “就这家，有什么适合我吃的？”

则不必重新执行：

```text
search_nearby_restaurants
```

可以直接继续：

```text
get_restaurant_menu
↓
personalize_restaurant
```

但如果用户只是提供一个模糊店名，当前还没有能够可靠对应真实门店的餐厅对象：

> 不能直接把模型记忆中的餐厅信息传给 `get_restaurant_menu`。

应先获得可靠的真实餐厅候选。

---

## 5.5 `get_restaurant_menu`

只有已经存在真实餐厅候选时，才能调用：

```text
get_restaurant_menu
```

不要在没有具体餐厅对象时调用。

该 Tool 返回的菜单 / 菜品证据可能包括：

* `verified_menu`；
* `amap_tag`；
* `type_fallback`。

具体什么条件属于哪个等级，以及可以怎样表达，统一按 `amap-api.md` 执行。

本文件不重新定义菜单证据标准。

---

## 5.6 `personalize_restaurant`

只有已经获得：

* 真实餐厅对象；
* 对应的菜单 / 菜品 / 店型降级结果；

之后，才调用：

```text
personalize_restaurant
```

将：

* `restaurant`；
* `menu`；
* 当前餐次；

传入 Tool。

由该 Tool 根据当前用户状态完成个性化处理。

最终推荐候选如何比较和选择，按 `recommendation-rules.md` 执行。

---

## 5.7 `search_nutrition` 在餐厅流程中的使用

`search_nutrition` 不是餐厅主链的默认必调 Tool。

只有在具体菜品推荐确实需要额外营养数据，而且当前已有数据不足时再调用。

例如：

已经通过菜单证据确认某道菜真实存在，但当前没有足够营养信息，需要进一步判断其与餐次目标的关系。

此时可以：

```text
search_nutrition
```

但：

> 菜品存在可信度和营养数据可信度是两件不同的事。

具体判断按：

* `amap-api.md`
* `nutrition-data.md`

分别执行。

---

## 6. Tool 依赖关系

### `compose_diy_recipe`

前置：

> 用户真实可用食材。

没有真实食材信息时，不自行生成并调用。

---

### `search_nearby_restaurants`

前置：

> 经纬度，或可用于位置转换的 `area`。

既没有位置，也没有区域信息时，不调用。

---

### `get_restaurant_menu`

前置：

> 已经存在真实餐厅候选对象。

不要使用模型自行构造的餐厅对象调用。

---

### `personalize_restaurant`

前置：

> 真实餐厅对象 + 对应菜单 / 菜品 / 店型降级结果。

不要跳过菜单信息获取直接假设具体菜品。

---

### `search_nutrition`

前置：

> 有明确需要查询的食材或菜品名称。

不要为了“可能有用”批量查询无关候选。

---

## 7. 已有结果的复用

如果当前对话中已经存在本轮仍然有效的 Tool 结果，应优先继续使用。

例如已经获得：

```text
search_nearby_restaurants
→ 餐厅 A / B / C
```

用户接着说：

> “看看第一家吃什么。”

则直接使用餐厅 A 继续：

```text
get_restaurant_menu
→ personalize_restaurant
```

不要再次用完全相同的条件搜索附近餐厅。

同理：

如果当前已经存在可靠的本餐预算：

> 不再次调用 `get_meal_budget`。

---

## 8. Tool 失败后的处理

### 8.1 缺少位置

`search_nearby_restaurants` 因缺少位置无法执行时：

* 不编造附近餐厅；
* 让用户补充城市 / 商圈 / 地址，或使用产品提供的位置入口。

---

### 8.2 餐厅搜索无结果

如果没有真实候选：

* 不创建虚构餐厅；
* 只有在查询条件发生有效变化时才重新搜索，例如合理扩大范围或调整用户已经允许放宽的软条件；
* 不用完全相同的参数重复调用。

---

### 8.3 菜单证据不足

如果 `get_restaurant_menu` 已返回：

* `amap_tag`；
* 或 `type_fallback`；

说明当前 Tool 已经完成对应证据降级。

不要为了获得“更好看的答案”使用完全相同输入反复调用 `get_restaurant_menu`。

继续使用当前结果完成推荐。

证据对应的表达边界按 `amap-api.md` 执行。

---

### 8.4 营养信息不足

如果当前营养信息不足：

* 按 `nutrition-data.md` 判断是否需要进一步查询；
* 无可靠结果时降低营养结论的确定性；
* 不自行补造精确热量。

---

## 9. 典型调用示例

### 示例 1：场景未明确

用户：

> “中午吃什么？”

当前没有 DIY 或餐厅信号。

正确：

```text
不进入具体 Tool 推荐链
→ open_meal_choice
```

不要：

```text
get_meal_budget
→ compose_diy_recipe
```

也不要：

```text
search_nearby_restaurants
```

---

### 示例 2：明确 DIY，信息基本齐全

用户：

> “中午在家吃，家里有鸡胸肉、番茄、西兰花。”

当前上下文已经有：

* 午餐预算；
* 用户状态。

正确：

```text
compose_diy_recipe
```

最终输出 `action.type=open_diy`。

不需要为了固定流程再次：

```text
read_user_state
→ get_meal_budget
```

---

### 示例 3：明确 DIY，但缺当前预算

用户：

> “今晚在家吃，还是这些食材。”

当前有食材和用户状态，但没有可靠晚餐预算。

正确：

```text
get_meal_budget
→ compose_diy_recipe
```

最终输出 `action.type=open_diy`。

---

### 示例 4：明确附近餐厅，已有商圈

用户：

> “中午出去吃，我在静安寺附近。”

正确：

```text
search_nearby_restaurants(area="静安寺")
→ get_restaurant_menu
→ personalize_restaurant
```

如果当前预算缺失，则在进入餐厅主链前补：

```text
get_meal_budget
```

---

### 示例 5：继续讨论已经搜到的餐厅

上一轮已经获得真实餐厅 A。

用户：

> “第一家有什么适合我的？”

正确：

```text
get_restaurant_menu(餐厅A)
→ personalize_restaurant
```

不要重新：

```text
search_nearby_restaurants
```

---

### 示例 6：菜单只能降级到高德特色菜

```text
search_nearby_restaurants
→ 餐厅 A
→ get_restaurant_menu
→ amap_tag
→ personalize_restaurant
```

继续根据该有限证据进行个性化推荐。

不要再次使用相同参数调用 `get_restaurant_menu`，试图让模型生成 `verified_menu`。

---

### 示例 7：菜单只能店型降级

```text
search_nearby_restaurants
→ 餐厅 A
→ get_restaurant_menu
→ type_fallback
→ personalize_restaurant
```

最终只提供与当前证据等级一致的店型 / 点餐建议。

不要自行补造具体菜单。

---

## 10. 与其他文件的职责边界

### `SKILL.md`

负责：

> 下一餐推荐业务流程和 DIY / 餐厅 / 场景未明确的分流。

---

### `recommendation-rules.md`

负责：

> 候选硬过滤、软偏好排序、主推荐选择和业务降级。

---

### `nutrition-data.md`

负责：

> 营养数据查询、匹配、可信度和估算规则。

---

### `amap-api.md`

负责：

> 餐厅 POI、菜单来源、菜品证据和真实世界数据可信边界。

---

### Tool Description

负责：

> 每个 Tool 自己能做什么、需要什么参数、返回什么结果。

---

### 本文件

负责：

> 在 `meal-recommendation` Skill 已经确定具体任务后，多个 Tool 应该如何选择、依赖和衔接。
