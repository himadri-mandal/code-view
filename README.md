# java-canvas

Generate a linked set of [JSON Canvas](https://jsoncanvas.org) diagrams for any Java project, with first-class support for **Spring Boot**, **Kafka** and **Spring AI**. Open the output in Obsidian (or any JSON Canvas viewer) and drill down from the system overview to a single method's flowchart.

```bash
npx java-canvas path/to/java-project          # writes path/to/java-project/code-view/
```

No JDK is needed. Sources are parsed with tree-sitter (WASM), and type and call resolution is done heuristically from imports, fields, locals and Spring injection.

## What you get

```
code-view/
  index.canvas                        L0  system context
  events.canvas                       L1  Kafka event map (only if Kafka is used)
  components/<module>.components.canvas  L1  layered component diagram per module
  flows/<Class>.<method>.flow.canvas     L2  call flow per entry point
  methods/<Class>.<method>.cfg.canvas    L3  statement-level flowchart
  README.md                           legend + table of every entry point
```

| Canvas | Shows |
|---|---|
| **index** | Each Maven/Gradle module as lanes (Inbound → Service → Outbound → Model, Config). Inbound triggers (HTTP API, schedulers, startup runners, Spring events) are on the left. External systems are on the right: databases from Spring Data/JDBC, Kafka topics, the LLM with its configured models, vector stores, and HTTP services. |
| **events** | Producers → topics → consumers. Topic names are resolved from literals, constants, `@Value("${…}")` fields and `application.yml`. Also shows partitions/replicas from `NewTopic`/`TopicBuilder`, payload types, consumer groups, and `@RetryableTopic` retry/DLT topics with their `@DltHandler`. Also understands `@SendTo`, `StreamBridge`, Spring Cloud Stream functional bindings and Kafka Streams. |
| **components** | Classes grouped by package inside role lanes. Edges cover constructor/field/`@Bean` injection, `extends`/`implements`, and entity relations. Library beans such as `KafkaTemplate`, `ChatClient` and `VectorStore` appear in an infrastructure column. |
| **flows** | One canvas per entry point: `@GetMapping`…, `@KafkaListener`, `@Scheduled`, `@EventListener`, `@Tool`, `CommandLineRunner`, `main`, and functional stream beans. Each class is a group. Calls are numbered in execution order, and branch context is noted, e.g. `3 [if result.hasErrors()]`. A `kafkaTemplate.send` ends in a topic node that links to the consumer's flow, so you can follow an event across services. LLM calls link to the `@Tool` methods the model may invoke. |
| **methods** | Flowchart of `if`/`else`, `switch`, loops (with back edges), `break`/`continue`, `try`/`catch`/`finally`, `return` and `throw`. Straight-line code is merged into blocks. Calls link to the callee's flowchart. |

Every node has a source link (`vscode://file/...:line` by default) that opens your editor.

## Options

```
java-canvas [projectDir]
  -o, --out <dir>           output directory (default: <projectDir>/code-view)
  -p, --profile <names>     merge application-<profile>.yml/properties
  -d, --depth <n>           max call depth per flow (default 6)
      --max-steps <n>       max calls drawn per flow (default 60)
  -e, --entry <filters>     only trace entry points whose id/trigger contains these
      --methods <mode>      flowcharts for: flows (default) | all | none
      --include/--exclude   source globs
      --include-tests       also parse src/test/java
      --include-accessors   keep getters/setters in call flows
      --editor <name>       source links: vscode | cursor | idea | none
```

Programmatic use: `import { generate, analyze } from 'java-canvas'`.

## Development

```bash
npm install
npm run fixtures   # clones spring-petclinic and spring-petclinic-ai at pinned commits
npm test           # unit + fixture tests (kafka-mini is checked in)
npm run build
```

Fixtures:
- [spring-petclinic](https://github.com/spring-projects/spring-petclinic): MVC controllers, Spring Data, JPA entities
- [spring-petclinic-ai](https://github.com/spring-petclinic/spring-petclinic-ai): Spring AI `ChatClient`, `@Tool` function calling, a vector store
- `test/fixtures/kafka-mini`: two-module Kafka app covering `KafkaTemplate`, `StreamBridge`, `@RetryableTopic`/`@DltHandler`, `@SendTo`, `NewTopic`, Spring events, `@Scheduled` and `RestClient`

## Limitations

- Resolution is heuristic: there is no classpath. Calls on library types are only drawn when they mean something architecturally (DB, Kafka, LLM, HTTP). An interface call with more than four implementations is drawn against the interface.
- Topic names built at runtime show as `? <expression>`.
- Lambdas are traversed for calls but are not expanded in method flowcharts.
