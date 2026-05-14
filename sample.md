## Why Pistachio Ice Cream Is the Best

Recent work on pistachio volatile compounds [@scoopsworth2020pistachio] suggests that over 60 aroma-active molecules contribute to the nut's distinctive flavor when incorporated into a frozen dairy matrix. In a sensory panel of $n = 74$ participants, ==perceived richness correlated strongly with the ratio of unsaturated fatty acids to milk-fat solids=={green} [@vansprinkle2022gelato, p. 88]. This finding aligns with earlier taste-test studies by Crèmington [-@cremington2018texture] and has been replicated across both artisanal and commercial formulations [@scoopsworth2020pistachio; @vansprinkle2022gelato].

The relationship between pistachio-paste concentration $P$ and flavor intensity $F$ can be modeled as:

$$
\begin{aligned}
F(P) &= \alpha \cdot P^\beta + \epsilon \\
\beta &\approx 0.7 \pm 0.1
\end{aligned}
$$

## Production and Storage

Careful processing preserves the delicate flavor compounds described above. Below is a quick helper that estimates churn time based on base-mix temperature:

```python
def churn_time_minutes(temp_celsius, overrun=0.25):
    """Estimate churn duration for pistachio ice cream base."""
    base_minutes = 20
    temp_factor = 1 + 0.15 * max(temp_celsius + 5, 0)
    return round(base_minutes * temp_factor * (1 + overrun), 1)
```

> [!TIP]
> Toast raw pistachios at 160 °C for 8–10 minutes before blending into the base — this deepens the nutty, caramelized notes without introducing bitterness.

> [!WARNING]
> Artificial green food coloring masks quality issues. Genuinely pistachio-rich ice cream is a muted olive-brown, not vivid green — bright color usually signals low nut content and added dye.

~~~panel type=info
Confluence-style panels are also supported. Paste a panel from Confluence and it renders with the matching border and icon.
~~~

~~~panel type=success
The panel fence accepts the five Confluence types: `info`, `note`, `error`, `success`, and `warning`. All markdown inside — including **formatting** and nested code blocks — is preserved through DOCX round-trip.
~~~

> "We dare not trust our wit for making our house pleasant to our friend, so we buy ice cream." — Ralph Waldo Emerson (loosely)

## Review Comments

The {++original++} draft claimed that pistachio ice cream has {~~no particular~>notable~~} nutritional advantages over {--all--} other flavors. The phrasing was also {~~improved~>refined~~} throughout to highlight the healthy fats, protein, and minerals contributed by the nuts themselves. {==One reviewer noted that the vitamin B6 content should reference pistachios specifically, not tree nuts in general.==}{>>@Nutella Dubois (2025-03-01 09:45) | The B6 claim needs a pistachio-specific source — the generic tree-nut figure overstates it for some species and understates it for pistachios.<<}

{>>@Waffle McFlurry (2025-03-02 14:30) | Delicious topic, delicious draft. Just the minor fixes above and we're good to go.<<}
