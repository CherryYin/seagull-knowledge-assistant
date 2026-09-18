# Ubiquitous Language

## Harness runtime

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Session** | One persisted Harness conversation and its event stream. | Conversation memory, chat memory |
| **Session Checkpoint** | A replaceable summary used only to continue one Session when its context window becomes large. | Long-term memory, conversation memory |
| **Agent Memory Candidate** | A proposed cross-session operational memory that has not yet been accepted by the user. | Knowledge candidate, PKG memory, memory node |
| **Agent Memory** | User-confirmed cross-session context that helps Harness remember preferences, constraints, or ongoing work. | Knowledge, profile fact, note, memory tree |

## User profile

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Profile Fact** | A user-confirmed statement about the user's identity, interests, roles, or stable working context. | Personal memory, user memory, agent memory |
| **Preference** | A user-confirmed choice about interaction style, output format, tools, or working conventions. | Personal memory, behavior memory |
| **Profile Signal** | An inferred and revisable indication derived from user activity that may support, but never override, explicit Profile Facts or Preferences. | Inferred memory, implicit fact |
| **Production History** | An ordered history of Asset generation, editing, export, publication, and feedback events. | Production memory, activity memory |

## PKG knowledge

| Term | Definition | Aliases to avoid |
| --- | --- | --- |
| **Source** | User-owned or imported evidence preserved in PKG. | Memory, knowledge node |
| **Note** | User-authored working knowledge preserved in PKG. | Agent memory, source note |
| **Wiki Page** | A maintained synthesis of durable knowledge with explicit Note and Source provenance. | Memory page, knowledge tree node |
| **Asset** | A user-owned writing or publishing deliverable such as a blog post, research brief, newsletter, knowledge pack, or topic report. | Production memory, source note, generic knowledge asset |
| **Knowledge Record** | The umbrella term for durable PKG content: Source, Note, Wiki Page, or Asset. | Memory node, knowledge tree |
| **Workflow Result** | A Harness-generated proposal that remains outside PKG until the user explicitly saves it as a Knowledge Record. | Auto-saved knowledge, agent write |

## Relationships

- A **Session** may produce zero or more **Agent Memory Candidates**.
- An **Agent Memory Candidate** becomes **Agent Memory** only after explicit user confirmation.
- **Profile Facts**, **Preferences**, and **Profile Signals** belong to the user profile; they are not **Agent Memory** or PKG evidence.
- **Production History** describes actions performed on **Assets**; it is not a memory store and is not evidence for factual claims.
- A **Workflow Result** becomes a **Note**, **Wiki Page**, or **Asset** only after an explicit user save action.
- **Agent Memory** may guide Harness behavior, but factual answers must still use PKG **Knowledge Records** as evidence.

## Example dialogue

> **Dev:** "The user said they prefer concise Chinese answers. Should that become a Note?"
>
> **Domain expert:** "No. Save it as a **Preference** in the user profile, or propose it as an **Agent Memory Candidate** if Harness needs it across sessions."
>
> **Dev:** "What about a generated research brief?"
>
> **Domain expert:** "That is a **Workflow Result** until the user confirms it. After confirmation it becomes an **Asset**, and later exports or feedback appear in **Production History**."
>
> **Dev:** "Can Agent Memory support a factual citation?"
>
> **Domain expert:** "No. Harness must retrieve a **Source**, **Note**, or **Wiki Page** from PKG for evidence."

## Flagged ambiguities

- `memory` was previously used for Agent runtime context, user profile records, production events, and PKG knowledge nodes. These are now four separate concepts: **Agent Memory**, **Profile Fact/Preference**, **Production History**, and **Knowledge Record**.
- `production_memory` remains a legacy storage discriminator in PKG. Product language and new code should use **Production History**; rename the persisted discriminator only through a dedicated compatibility migration.
- `UserMemory` remains a legacy PKG model name that stores profile records and production history. Product language must not expose it as “User Memory.”
- `knowledge tree` referred to the retired Memory Tree and sometimes to general PKG context. New product language should use **Knowledge Record**, **Wiki Page**, or the specific record type.
- `knowledge asset` was used both as an umbrella for durable knowledge and as the concrete `Asset` entity. Use **Knowledge Record** for the umbrella and **Asset** for writing/publishing deliverables.
