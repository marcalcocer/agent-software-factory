# Global Java / JVM Conventions

> Scope: every JVM target repository (Java, Kotlin, Spring Boot, Quarkus, Maven, Gradle).
> Precedence: these rules are **defaults**. A `AGENTS.md` file in the target repository
> always wins when it contradicts this document.

## 1. Language level & tooling

- Target the Java version declared by the build file (`maven.compiler.release`, `java.toolchain`).
  Never silently upgrade or downgrade it.
- Prefer the build wrapper when present: `./mvnw`, `./gradlew`. Fall back to `mvn` / `gradle`.
- Never edit `pom.xml` / `build.gradle(.kts)` to add a dependency unless the task requires it.
  When a dependency is unavoidable: pin an explicit version, prefer the BOM already in use,
  and justify it in the pull-request description.

## 2. Project layout

- Production code in `src/main/java`, tests in `src/test/java`, mirroring the package path.
- One public type per file. File name equals the public type name.
- Package names: lowercase, no underscores, reverse-domain (`com.company.product.module`).
- Keep layers explicit and acyclic: `controller` / `api` -> `service` / `application` ->
  `repository` / `infrastructure` -> `domain`. Domain code must not import framework
  annotations from the web or persistence layers.

## 3. Naming

| Element                 | Convention                     | Example                       |
| ----------------------- | ------------------------------ | ----------------------------- |
| Class / interface       | `UpperCamelCase`               | `InvoiceService`              |
| Method / field / param  | `lowerCamelCase`               | `calculateNetAmount`          |
| Constant                | `UPPER_SNAKE_CASE`             | `MAX_RETRY_ATTEMPTS`          |
| Generic type parameter   | single uppercase letter        | `T`, `R`, `K`, `V`            |
| Test method             | `should<Behaviour>_when<Case>` | `shouldRejectOrder_whenStockIsEmpty` |

- No Hungarian notation, no `I` prefix on interfaces, no `Impl` suffix unless a single
  implementation of a port genuinely exists (hexagonal adapters are the exception).
- Booleans read as predicates: `isActive`, `hasPermission`, `canRetry`.

## 4. Code style

- 4-space indentation, no tabs. Max line length 120 characters.
- Always use braces for control blocks, even single statements.
- Declare fields `private final` by default; expose behaviour, not state.
- Prefer immutability: `record` for DTOs/value objects, `List.of` / `Map.of` for constants,
  defensive copies on collection getters when the type is mutable.
- `var` is allowed only when the initializer makes the type obvious.
- Use `Optional` as a return type for "may be absent". Never as a field or method parameter.
- Streams for data transformation, loops when side effects or early exit dominate.
  Never nest more than two stream pipelines in a single statement.
- Order of class members: static constants, instance fields, constructors, public methods,
  protected, private, inner types.

## 5. Spring Boot / dependency injection

- Constructor injection only. No `@Autowired` on fields, no setter injection.
- Keep configuration in `@ConfigurationProperties` classes, not scattered `@Value` fields.
- Controllers are thin: validate input, delegate to a service, map to a response DTO.
  Never return entities from a controller.
- Transactions belong to the service layer: `@Transactional` with the narrowest scope,
  `readOnly = true` for queries.
- Prefer explicit mapping (hand-written mappers or MapStruct) over reflection-based copying.

## 6. Error handling

- Never swallow exceptions. No empty `catch` blocks, no `catch (Exception e) {}`.
- Do not use exceptions for control flow.
- Throw domain-specific exceptions (`OrderNotFoundException`) and translate them to transport
  errors in one place (`@RestControllerAdvice` / exception mapper).
- Always preserve the cause: `throw new DomainException("message", cause)`.
- Validate public inputs at the boundary (`jakarta.validation`, explicit guards) and fail fast
  with actionable messages.

## 7. Logging & observability

- SLF4J only (`private static final Logger log = LoggerFactory.getLogger(X.class);`) or Lombok
  `@Slf4j` if the project already uses Lombok. Never `System.out.println`.
- Parameterized logging: `log.debug("Order {} rejected: {}", id, reason)`. No string concatenation.
- Log levels: `ERROR` unexpected failure needing action, `WARN` recoverable anomaly,
  `INFO` business milestone, `DEBUG` developer detail, `TRACE` payload-level noise.
- Never log secrets, tokens, passwords, full card numbers or personal data.
- Log messages are written in **English**.

## 8. Persistence

- No `SELECT *` in native queries; project only the columns you need.
- Parameterized queries / named parameters only. String-concatenated SQL is a blocking defect.
- Explicit fetch strategies: `LAZY` by default, join fetch where N+1 would appear.
- Schema changes go through migrations (Flyway/Liquibase). Never rely on
  `hibernate.ddl-auto=update` outside local development.

## 9. Concurrency

- Prefer immutable data and `java.util.concurrent` primitives over `synchronized` blocks.
- Never create unbounded thread pools; configure and name every executor.
- Document thread-safety expectations of shared components in the class Javadoc.

## 10. Documentation

- Javadoc on public API types and non-obvious public methods: purpose, parameters, return,
  thrown exceptions. Skip Javadoc that merely repeats the signature.
- Comments explain **why**, never **what**. Delete commented-out code instead of shipping it.
- All identifiers, comments and documentation are written in **English**.

## 11. Hard constraints (blocking on review)

1. No hardcoded secrets, credentials, tokens or environment-specific URLs.
2. No `TODO` / `FIXME` introduced without an associated ticket reference.
3. No disabled or commented-out tests to make a build pass.
4. No public mutable static state.
5. No formatting-only churn mixed into a functional change.
