# Documentation · Документація

| English | Українська |
| --- | --- |
| [Project guide](guide.en.md) | [Посібник проєкту](guide.uk.md) |
| [Architecture infographic — SVG](assets/overview.en.svg) | [Інфографіка архітектури — SVG](assets/overview.uk.svg) |
| [Architecture infographic — PNG](assets/overview.en.png) | [Інфографіка архітектури — PNG](assets/overview.uk.png) |

The two guides cover the same roles, transports, configuration, deployment, operations, security boundaries and verification steps. They describe the checked-in implementation, not the status of a live deployment.

Обидва посібники однаково охоплюють ролі, режими роботи, конфігурацію, розгортання, експлуатацію, межі безпеки й перевірки. Вони описують реалізацію в репозиторії, а не стан розгорнутої системи.

## Detailed references · Детальні матеріали

These existing references are in English. RPC-specific documents identify their scope; use the bilingual guides for a comparison of both transports.

Наявні детальні матеріали нижче — англійською. Документи про RPC позначають свою область застосування; порівняння обох режимів наведено у двомовних посібниках.

- [Persistent tmux team](tmux-team.md)
- [RPC architecture](architecture.md)
- [Roles](roles.md)
- [Slack setup](slack-setup.md)
- [Operations](operations.md)
- [Security model](security.md) and [security policy](../SECURITY.md)
- [Configuration examples](../config/README.md) and [Slack manifests](../manifests/README.md)
- [Runtime decision](adr/0001-runtime.md) and [RPC delegation decision](adr/0002-inter-agent-delegation.md)
- [Implementation plan](PLAN.md) — historical planning material, not a deployment report / історичний план, не звіт про розгортання

## Keeping the languages aligned · Узгодження мов

Update the matching section in both guides when behavior changes. Keep configuration keys, commands, limits and source links identical. Update both infographic SVG files and regenerate their PNG previews when the architecture changes.

Змінюючи поведінку, оновлюйте відповідний розділ обох посібників. Ключі конфігурації, команди, ліміти й посилання на код мають збігатися. Якщо змінюється архітектура, оновлюйте обидва SVG та їхні PNG-прев’ю.
