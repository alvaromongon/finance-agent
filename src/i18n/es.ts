// Spanish output catalog: the owner's language. Typed as
// `Messages`, so it must provide every key of the English catalog.
import type { Messages } from "./index.js";

export const es: Messages = {
  // es-ES does not group thousands in four-digit numbers; de-DE does, with the same marks.
  locale: "de-DE",
  and: " y ",

  mail: {
    alertSubject: (action, ticker) => `[Finance Agent] ALERTA DE OPERACIÓN: ${action} ${ticker}`,
    orderTicketTitle: "TICKET DE ORDEN",
    adjustStopTitle: "AJUSTE DE STOP-LOSS",
    tickerField: "Ticker",
    directionField: "Dirección",
    engineNote: "Stop, unidades e importe los calcula el motor (ADR-0009); el objetivo lo propone el análisis.",
    noticesTitle: "AVISOS",
    assumptionsTitle: "SUPUESTOS",
    thesisTitle: "TESIS",
    convictionLabel: "Convicción:",
    triggersLabel: "Disparos:",
    disclaimer:
      "Este mensaje es soporte a la decisión, no asesoramiento financiero. " +
      "La ejecución de cualquier orden es manual y responsabilidad del propietario.",
  },

  ticket: {
    units: "Unidades",
    approxUnits: "Unidades aprox.",
    amount: "Importe",
    referencePrice: "Precio de referencia",
    stopLoss: "Stop-loss",
    target: "Objetivo",
    risk: "Riesgo",
    riskValue: (risk, budget, cap) => `${risk} de ${budget} (${cap})`,
    rewardRisk: "R:R",
    rewardRiskValue: (gross, net) => `${gross} bruto · ${net} neto`,
    estimatedCosts: "Costes estimados",
    taxedCosts: (costs, taxPct) => `${costs} (impuesto sobre transacciones ${taxPct}%)`,
    untaxedCosts: (zero) => `${zero} (sin impuesto sobre transacciones)`,
    newStop: "Nuevo stop-loss",
    newStopValue: (stop, atr) => `${stop} (${atr} ATR bajo el precio)`,
    previousStop: "Stop anterior",
    noStop: "sin stop",
    cappedBy: {
      risk: "presupuesto de riesgo",
      position: "limitado por el tope por posición",
      cash: "limitado por el cash disponible",
    },
  },

  conviction: {
    points: (minRewardRisk) => ({
      top_quintile: "quintil superior",
      regime_favorable: "régimen favorable",
      reward_risk: `R:R ≥ ${minRewardRisk}`,
      dated_catalyst: "catalizador fechado",
    }),
  },

  regime: {
    effects: {
      favorable: "FAVORABLE (referencia sobre su SMA200 y SMA50 subiendo)",
      neutral: "NEUTRAL (sin efecto)",
      adverso: "ADVERSO (referencia bajo su SMA200): toda entrada nueva queda BLOQUEADA",
    },
    noData: "sin datos, no bloquea",
    line: (currency, reference, description) => `Régimen ${currency}${reference}: ${description}`,
  },

  setup: {
    patterns: { pullback: "retroceso en tendencia", breakout: "ruptura" },
    armed: (ticker, pattern, level, currency, target) =>
      `${ticker}: ${pattern} ARMADA — Buy Stop en ${level} ${currency}, objetivo ${target}`,
    confirmed: (ticker, pattern, level, currency, target) =>
      `${ticker}: ${pattern} confirmado a ${level} ${currency}, objetivo ${target}`,
    sizing: (stop, units, amount, currency, rrNet) =>
      ` · stop ${stop}, ${units} u. ≈ ${amount} ${currency}, R:R neto ${rrNet}`,
    sma50Distance: (atr) => ` · dist. SMA50 ${atr} ATR`,
    eligible: "ELEGIBLE",
    blocked: (reasons) => `BLOQUEADO (${reasons})`,
  },

  heartbeatDigest: {
    subject: (currency, sections) => `[Finance Agent] Heartbeat ${currency} — ${sections}`,
    labels: {
      breaches: "stop cruzado",
      lots: "problema con los lotes",
      tickers: "ticker que no se lee",
      unreadableCells: "celda que no se puede contar",
      tightStops: "stop ceñido",
      armed: "ruptura armada",
      escalated: "a análisis",
    },
    breachIntro: (syncedAt) => [
      `## Stops cruzados — verifica tu bróker`,
      ``,
      `Estas posiciones cotizan **por debajo de su stop-loss registrado**.`,
      ``,
      `El motor no puede saber si el bróker ya ejecutó el stop: \`portfolio.md\` se`,
      `sincroniza a mano y su última sincronización es del **${syncedAt}**.`,
      `Comprueba la cuenta y, si el stop no saltó, decide con la disciplina de`,
      `\`strategies/base.md\` (respetar el stop aunque la tesis siga viva).`,
      ``,
    ],
    breachHeader: [`| Ticker | Precio | Stop | Bajo el stop | P/L latente |`, `|---|---|---|---|---|`],
    breachOutro: [
      ``,
      `Tras actualizar la cuenta, refleja el cambio en \`portfolio.md\``,
      `(guía: \`routines/portfolio-sync.md\`) para que el resto del sistema deje`,
      `de razonar sobre una posición que ya no existe.`,
    ],
    lotsIntro: [
      `## \`portfolio.md\`: problema con los lotes`,
      ``,
      `La tabla \`Lots\` no se puede leer, falta, o no concuerda con \`Positions\` o con el registro de decisiones. El`,
      `heartbeat sigue vigilando tus posiciones (stops, \`Volume\`, \`Avg price\`), pero \`decision:record\` y la`,
      `evaluación rechazan el archivo hasta que se corrija:`,
      ``,
    ],
    lotsOutro: [
      ``,
      `Corrige \`Lots\` a mano: que exista y se lea, que cada \`Volume\` sea la suma de las \`Units\` de sus lotes y cada`,
      `\`Entry id\` sea una entrada del registro (\`logs/decisions.jsonl\`; ver \`docs/input-format.md\`).`,
    ],
    tickersIntro: [
      `## \`portfolio.md\` o \`watchlist.md\`: ticker que no se lee`,
      ``,
      `Estas filas tienen un ticker fuera del patrón (letras, dígitos y \`. - ^ =\`) y se omiten. El heartbeat sigue`,
      `vigilando todo lo demás, pero no vigila estas filas hasta que se corrijan; \`decision:record\` rechaza un`,
      `ticker de \`Positions\` del silo que registra o de la watchlist que no se lee, y \`decisions:evaluate\` uno de`,
      `\`Positions\` (nunca lee la watchlist):`,
      ``,
    ],
    tickersOutro: [``, `Corrige el ticker a mano (ver \`docs/input-format.md\`).`],
    unreadableCellsIntro: [
      `## \`portfolio.md\`: celda que no se puede contar`,
      ``,
      `Estas celdas tienen un importe demasiado grande para contarlo en céntimos. Se leen como no legibles (un P/L`,
      `como 0, el efectivo disponible como 0, el efectivo total como ausente) y la fila se sigue vigilando. Leer el`,
      `efectivo disponible o total como 0 o ausente solo puede recortar o bloquear una compra, nunca agrandarla; el P/L es solo informativo:`,
      ``,
    ],
    unreadableCellsOutro: [``, `Corrige la celda a mano (ver \`docs/input-format.md\`).`],
    tightIntro: (minAtr) => [
      `## Stops demasiado ceñidos`,
      ``,
      `Estas posiciones tienen el stop-loss a **menos de ${minAtr} ATR** del precio`,
      `actual: está dentro del ruido normal del activo, así que lo más probable es`,
      `que salte por una sesión mala y no porque la tesis se haya roto.`,
      ``,
    ],
    tightHeader: (referenceAtr) => [
      `| Ticker | Precio | Stop | Distancia | ATR14 | Múltiplo | Stop a ${referenceAtr} ATR |`,
      `|---|---|---|---|---|---|---|`,
    ],
    tightOptions: [
      ``,
      `Opciones, en orden de preferencia (\`portfolio-policy.md\` → "Stop-loss en`,
      `múltiplos de ATR"):`,
      ``,
      `1. **Ensanchar el stop** hasta la distancia de referencia de la última`,
      `   columna, si la tesis sigue viva y asumes esa pérdida sin incomodidad.`,
      `2. **Reducir el tamaño** de la posición y ensanchar el stop: la pérdida en`,
      `   € vuelve a ser tolerable sin ceñir la distancia.`,
      `3. **Cerrar** si la tesis ya no te convence — pero ciérrala por eso, no`,
      `   dejando un stop pegado que ejecute la decisión por ti.`,
      ``,
      `Un stop no se acerca para arriesgar menos: para eso se compra menos.`,
    ],
    tightBelowEntry: (tickers) => [
      ``,
      `⚠️ En ${tickers} el stop de referencia queda **por`,
      `debajo del precio medio de compra**: ensancharlo convierte un stop que protegía`,
      `beneficio en uno que admite pérdida. Si la posición ya va ganando y quieres`,
      `asegurar parte, la opción 2 (recortar volumen) suele ser mejor que ceñir el stop.`,
    ],
    tightOutro: (syncedAt) => [
      ``,
      `El stop real vive en tu bróker: el motor solo lee la columna Stop loss de`,
      `\`portfolio.md\` (última sincronización: **${syncedAt}**). Si lo`,
      `cambias, refléjalo allí (guía: \`routines/portfolio-sync.md\`).`,
    ],
    armedIntro: [
      `## Rupturas armadas`,
      ``,
      `Base formada cerca de máximos y aún sin romper (ADR-0013).`,
      "Si es ELEGIBLE, se puede dejar en tu bróker una orden Buy Stop en el nivel, con vencimiento corto y el stop del motor.",
      ``,
    ],
    armedOutro: [
      ``,
      "Quedan en logs/decisions.jsonl como setup_armed. Si la orden se ejecuta, registrarla con decision:record.",
    ],
    escalatedIntro: [`## Señales enviadas a análisis`, ``],
    escalatedLine: (ticker, triggers, price, currency) => `- ${ticker}: ${triggers} a ${price} ${currency}`,
    escalatedSetup: (pattern, target) => ` (${pattern}, objetivo del patrón ${target})`,
    escalatedOutro: [
      ``,
      `Las analiza la Routine al terminar este heartbeat; recibirás una alerta aparte`,
      `solo si el análisis propone operar.`,
    ],
  },

  evaluation: {
    frontmatterTitle: "Evaluación de decisiones — cuadro del corte",
    generated: (asOf, count, span) => [
      `*Generado por \`npm run decisions:evaluate\` el ${asOf} desde \`logs/decisions.jsonl\` y los trimestres archivados:`,
      `${count} ${count === 1 ? "decisión" : "decisiones"} (${span}).  Sin LLM.*`,
    ],
    span: (from, to) => `${from} a ${to}`,
    emptyRegistry: "Registro vacío: todavía no hay decisiones que medir.",
    counterNotStarted: (rulesVersion, measuredFrom) => [
      "> [!info] Contador sin empezar",
      `> C v1 está en construcción (reglas ${rulesVersion}): el contador arranca con la primera entrada bajo las reglas 1.0.`,
      `> Hasta entonces, carteras y caída se miden **en ensayo** desde el inicio del registro (${measuredFrom}) y no cuentan para el corte.`,
    ],
    counterRunning: (start, rulesVersion) =>
      `*Contador en marcha desde el ${start}. Reglas vigentes: ${rulesVersion}.*`,
    expectancyNone: "— (sin operaciones con stop inicial)",
    expectancy: (r, withR, winners) => `${r} en ${withR} (${winners}/${withR} ganadoras)`,
    excludedNoStop: (n) => `; ${n} sin stop inicial, fuera`,
    totalNone: "— (sin cambio EUR/USD o sin cartera sombra de algún silo)",
    total: (real, shadow, diff) => `${real} frente a ${shadow} (${diff})`,
    boardHeader: ["| Indicador | Valor | Criterio (ADR-0009 §4) |", "|---|---|---|"],
    closedTradesRow: (total, review, decision) =>
      `| Operaciones cerradas del sistema bajo C v1 | ${total} | revisión a las ${review}, decisión a las ${decision} |`,
    expectancyRow: (value) => `| Esperanza, R neta | ${value} | > 0R |`,
    openTradesRow: (open) => `| Operaciones abiertas del sistema bajo C v1 | ${open} | — |`,
    portfoliosRow: (value) => `| Carteras reales frente a sombra, en EUR | ${value} | real ≥ sombra |`,
    siloHeader: [
      "| Silo | Referencia | Desde | Real | Sombra | Diferencia | Rent. real | Rent. sombra | Caída desde máximo | Caída máxima |",
      "|---|---|---|---|---|---|---|---|---|---|",
    ],
    drawdownPause: (currency, pct, peakDate, threshold) => [
      `> [!danger] Pausa por caída en el silo ${currency}`,
      `> Cae un ${pct}% desde su máximo del ${peakDate} (umbral ${threshold}%):` +
        " no se abren entradas nuevas en él hasta la retrospectiva mensual.",
    ],
    drawdownTrial: "> En ensayo: la medición oficial empieza con el contador.",
    groupsSmallSample: (min) => [
      "> [!warning] Muestra pequeña",
      `> Algún grupo tiene menos de ${min} casos: una diferencia de pocos puntos entre grupos es ruido.`,
    ],
    tradesSmallSample: (min) => [
      "> [!warning] Muestra pequeña",
      `> Con menos de ${min} operaciones, la esperanza describe, no decide.`,
    ],
    decisionsMissing: {
      title: "> [!warning] Faltan decisiones del registro",
      line: (before) => `faltan decisiones anteriores al ${before}: ¿está definido \`DECISIONS_ARCHIVE_DIR\`?`,
    },
    reconstructionMismatch: "> [!warning] La reconstrucción de los silos no cuadra",
    unmeasured: {
      title: "> [!warning] Salidas y lotes sin medir",
      exitsWithoutSnapshot: (n) =>
        `${n} ${n === 1 ? "salida" : "salidas"} sin instantánea del lote, fuera de las operaciones cerradas.`,
      oversoldLot: (ticker, lotId) =>
        `${ticker}, lote ${lotId}: sus ventas suman más unidades que la compra (datos incoherentes); no se mide.`,
      skippedExit: (ticker, date, lotId) => `${ticker}, ${date}${lotId ? `, lote ${lotId}` : ""}`,
      moreSkippedExits: (n) => `… y ${n} más.`,
      inconsistentLot: (ticker, lotId, reason) =>
        `${ticker}, lote ${lotId}: ${
          reason === "units_left"
            ? "las unidades que quedan tras cada salida no siguen lo que vendieron las salidas"
            : "sus salidas no coinciden en los datos de la compra"
        } (datos incoherentes); no se mide.`,
    },
    stopAt: (atr, horizon) => `${atr} ATR en ${horizon}`,
    howToRead: (o) => [
      "## Cómo leerlo",
      "",
      "- **Operación cerrada:** una `entry` y la `exit` que la cita. **R neta** = (salida − entrada − costes por unidad) / (entrada − stop inicial)",
      "  (ADR-0009 §2). El stop inicial es el de la entrada o, si falta, el de la propuesta que cita; sin él, la operación no entra en la",
      "  esperanza. Cuentan para el corte las entradas del sistema bajo C v1 (reglas 1.0 o posteriores).",
      "- **Carteras:** el valor real de cada silo se reconstruye hacia atrás desde `portfolio.md` (efectivo total y posiciones al cierre),",
      "  deshaciendo las operaciones y los flujos del registro. La sombra arranca con ese valor el día anterior al inicio y replica",
      "  cada aportación, retirada y conversión en la referencia del silo (ADR-0009 §1). Rentabilidad ponderada por dinero (Dietz",
      "  modificado). La caída se mide sobre la rentabilidad sin flujos, para que las aportaciones no tapen las pérdidas.",
      `- **Rentabilidad a ${o.horizons} sesiones** del propio valor desde el último cierre ≤ fecha de la decisión, y **exceso**`,
      "  frente a la referencia del silo entre las mismas fechas. Solo precio, sin dividendos. En un `hold`, una venta o una salida es lo",
      "  que hizo el valor después: positiva en una venta quiere decir que se vendió pronto. Los agregados solo cuentan plazos completos.",
      "- **Plan en R** de las compras (propuestas, bloqueos, entradas, screening y elegibles no propuestas): stop y objetivo del ticket.",
      `  Si faltan, stop a la distancia del horizonte con el ATR registrado (${o.stops}) y objetivo a ${o.minRewardRisk}R, marcados con †.`,
      `  En las ${o.planWindow} sesiones posteriores: máxima subida y máxima caída en R, y qué tocó antes. Si una sesión toca los dos, cuenta el stop.`,
      `  **R del plan:** la del objetivo, −1R en el stop (la barra diaria no ve los huecos) o la del último cierre si en ${o.planWindow} sesiones no tocó`,
      "  ninguno. «Stop → objetivo» es un stop que saltó antes de que el precio llegara al objetivo: muchos apuntan a stops demasiado ajustados.",
      "- **Observaciones no independientes:** las decisiones de una misma semana comparten mercado; la muestra efectiva es menor que el número de filas.",
      "",
    ],
    tradesTitle: "## Operaciones cerradas",
    noTrades: "Sin operaciones cerradas todavía.",
    tradeGroupsHeader: [
      "| Grupo | Operaciones | Con stop inicial | Esperanza (R neta) | Ganadoras |",
      "|---|---|---|---|---|",
    ],
    tradesHeader: [
      "| Entrada | Salida | Ticker | Silo | Origen | Reglas | Incumple | Stop inicial | R neta |",
      "|---|---|---|---|---|---|---|---|---|",
    ],
    countsLegend: "✓ Cuenta para el corte.",
    aggregatesTitle: "## Agregados",
    noDecisions: "Sin decisiones todavía.",
    aggregatesHead: "| Grupo | Decisiones | ",
    aggregatesHorizon: (h) => `Completas ${h}s | Media ${h}s | Exceso ${h}s`,
    aggregatesTail: " | Con R del plan | Objetivo antes | Stop antes | Stop → objetivo | R media del plan |",
    noData: "sin datos",
    pending: "pendiente",
    neither: "ninguno",
    neitherAfter: (sessions) => `ninguno (${sessions}s)`,
    target: "objetivo",
    stop: "stop",
    stopToTarget: "stop → objetivo",
    detailTitle: "## Detalle por decisión",
    detailNote:
      "*En cursiva, plazo aún sin cumplir (entre paréntesis, sesiones transcurridas). † stop u objetivo deducidos, no del ticket.*",
    noDecisionsToFollow: "Sin decisiones que seguir todavía.",
    detailHead: "| Fecha | Ticker | Tipo | Origen | Conv. | Reglas | Precio | ",
    detailHorizon: (h) => `${h} sesiones | Exceso ${h}s`,
    detailTail: " | Stop / objetivo | Máx. subida | Máx. caída | Primero | R del plan |",
    noHistory: (tickers) => `Sin histórico utilizable en Yahoo: ${tickers}.`,
    groupings: {
      originRules: (system, broke) =>
        `${system ? "Sistema" : "Propietario"}, ${broke ? "incumpliendo reglas" : "sin incumplir reglas"}`,
      cutCounter: "Contador del corte (sistema, C v1)",
      entriesTitle: "Entradas por origen y reglas",
      entriesNote:
        "¿Rinden más las entradas del sistema que las discrecionales, y las que cumplen las reglas que las que no?",
      convictionTitle: "Propuestas de compra por convicción",
      convictionNote:
        "Propuestas y bloqueos, por la convicción de la rúbrica del motor (ADR-0012 §7), que el heartbeat también calcula. ¿La convicción alta acierta más que la media? La que ponía el razonador va aparte.",
      noEngineConviction: "sin convicción del motor",
      eligibleTitle: "Elegibles frente a bloqueadas",
      eligibleNote:
        "¿Los bloqueos del motor (ADR-0010 y el marco) evitan malas entradas? «Elegibles no propuestas» son los setups elegibles que el razonador dejó pasar. Los dos grupos de bloqueadas son disjuntos: «por régimen» es la hipótesis de la versión 0.6 y «por otros motivos» su grupo de control.",
      proposals: "Propuestas",
      eligibleNotProposed: "Elegibles no propuestas",
      blockedByRegime: "Bloqueadas por régimen",
      blockedOther: "Bloqueadas por otros motivos",
      screeningTitle: "Screening: interesantes frente a descartados",
      screeningNote: "¿Lo que el screening marca como interesante rinde más que lo que descarta?",
      interesting: "Interesantes",
      rejected: "Descartados",
      screeningConvictionTitle: "Screening: interesantes por convicción",
      screeningConvictionNote:
        "¿La convicción de la rúbrica del motor (ADR-0012 §7) ordena la rentabilidad? Solo desde las reglas 0.8: antes la elegía el razonador.",
      rankingTitle: "Screening: ranking frente a exploración",
      rankingNote:
        "¿Los mejores del ranking rinden más que los elegidos al azar entre los que pasan el filtro 0 (ADR-0012)?",
      ranking: "Ranking",
      exploration: "Exploración",
      versionTitle: "Por versión de reglas",
      versionNote:
        "Propuestas, bloqueos y entradas. Cada cambio de reglas se evalúa solo con las decisiones posteriores (ADR-0009 §5).",
    },
    siloWarnings: {
      negativeCash: (currency, start, cash) =>
        `${currency}: la caja al ${start} sale negativa (${cash}); falta registrar alguna aportación, conversión o venta, o el efectivo total de portfolio.md no está al día.`,
      oversold: (currency, ticker, units, start) =>
        `${currency}: ${ticker} tendría ${units} unidades al ${start}; el registro compra más de lo que portfolio.md tiene, así que falta registrar una venta.`,
      missingCloses: (currency, tickers) =>
        `${currency}: sin cierres de ${tickers}; se valoran con el último precio conocido.`,
      noShadow: (currency, reference) =>
        `${currency}: sin cierres de ${reference} en el periodo; no hay cartera sombra.`,
    },
  },

  chart: {
    title: "Calidad de las propuestas (SLI 1)",
    insufficient: (n, min) => `Datos insuficientes: ${n} de ${min} propuestas evaluadas`,
    enough: (n) => `${n} propuestas evaluadas. Todavía no se calcula la cota de confianza (ADR-0014).`,
    summary: (meanR, benchmarkR) => `R medio del plan ${meanR} · referencia, mismas ventanas ${benchmarkR}`,
    noProposals: "Todavía no hay propuestas de compra evaluadas.",
    meanRLabel: "R medio del plan (acumulado)",
    benchmarkLabel: "Referencia, mismas ventanas (en R)",
    countLabel: "Propuestas evaluadas (n)",
    minSampleLabel: (min) => `n = ${min}`,
    method: [
      "R del plan: stop, objetivo o último cierre de cada propuesta en 60 sesiones.",
      "Referencia: su rentabilidad en la misma ventana, dividida por la distancia al stop.",
    ],
    notice: "No es asesoramiento financiero. Solo R y recuentos; sin importes.",
    description: (n, from, to) =>
      `R medio acumulado del plan de ${n} propuestas de compra evaluadas frente a la referencia, de ${from} a ${to}, y número de propuestas evaluadas a lo largo del tiempo.`,
    descriptionEmpty: "Todavía no hay propuestas de compra evaluadas.",
  },

  outcomes: {
    frontmatterTitle: "Screening outcomes — Qué pasó después de cada evaluación",
    generated: (today, count, tickers, span) => [
      `*Generado por \`npm run screening:outcomes\` el ${today} desde \`screening-log.md\`: ${count} evaluaciones`,
      `de ${tickers} tickers (${span}).  Sin LLM.*`,
    ],
    benchmarkFor: (symbol, index) => `${symbol} para ${index}`,
    howToRead: (o) => [
      "## Cómo leerlo",
      "",
      "- **Cierre base:** último cierre completo ≤ fecha de análisis (el screening corre en sábado: cierre del viernes).",
      "  Sin sesgo de anticipación: el resultado del screening ya estaba escrito ese día.",
      `- **Rentabilidad a ${o.horizons} sesiones** del propio valor. Si el plazo no se ha cumplido, la fila`,
      "  muestra lo transcurrido hasta el último cierre, pero **los agregados solo cuentan plazos completos**.",
      `- **Exceso:** rentabilidad del valor menos la de su índice entre las mismas fechas (${o.benchmarks}).`,
      "  Commodities no tiene referencia: 4GLD.DE es solo oro y no representa al bloque.",
      "- Solo precio: sin dividendos (ni en el valor ni en el índice) y en la divisa de cotización.",
      "- **Referencia de elegir al azar: solo «Todos (sorteo)», y aproximada.** Los candidatos salen de un sorteo",
      "  del universo que excluye lo que ya está en la watchlist y lo analizado en las 8 semanas previas.",
      "  «No interesante» no es aleatorio: es justo lo que el filtro rechazó.",
      `  Desde ${o.dd0016} los candidatos salen del ranking y «Todos (ranking)» no es azar: la comparación`,
      "  con el azar es «Screening: ranking frente a exploración» en `logs/decisions-evaluation.md` (ADR-0012).",
      "- **Observaciones no independientes:** las evaluaciones de una misma semana comparten mercado, y las de",
      "  semanas contiguas buena parte del plazo. La muestra efectiva es menor que el número de filas.",
      `- **Cohortes separadas en ${o.dd0010} (DD-0010) y ${o.dd0016} (ADR-0012):** antes de DD-0010 se descartaba`,
      "  lo que estaba cerca de máximos; con DD-0010, el analista descarta lo que está bajo la SMA200; desde ADR-0012,",
      "  el motor ordena el universo y el analista ya no ve lo que no pasa el filtro 0. No se mezclan.",
      "",
    ],
    cohorts: { pre: "Antes de DD-0010", post: "DD-0010 a ADR-0012", ranking: "Desde ADR-0012" },
    results: { interesting: "Interesante", not_interesting: "No interesante" },
    all: "Todos",
    allRanking: "Todos (ranking)",
    allDraw: "Todos (sorteo)",
    summaryTitle: (horizon) => `## Resumen a ${horizon} sesiones`,
    summaryHeader: [
      "| Cohorte | Resultado | Completas | Media | Mediana | Exceso medio | Exceso mediano | Bate al índice | Pendientes | Sin datos |",
      "|---|---|---|---|---|---|---|---|---|---|",
    ],
    noneComplete: (horizon) => `> [!info] Ninguna evaluación ha cumplido todavía ${horizon} sesiones.`,
    smallSample: (min) => [
      "> [!warning] Muestra pequeña",
      `> Algún grupo tiene menos de ${min} evaluaciones completas. Con estos tamaños, una diferencia`,
      "> de pocos puntos entre grupos es ruido: esta tabla describe, no decide.",
    ],
    reasonsTitle: "## Descartes por motivo",
    reasonsNote: [
      "*Motivo inferido del `Resumen` (truncado a 80 caracteres): clasificación heurística, orientativa.*",
      "*La fila «Interesante» de cada cohorte está de referencia.*",
    ],
    reasonsHead: "| Cohorte | Motivo | Evaluaciones | ",
    reasonsHorizon: (h) => `Completas ${h}s | Media ${h}s | Exceso ${h}s`,
    interestingReference: "*(Interesante)*",
    detailTitle: "## Detalle por evaluación",
    detailNote:
      "*En cursiva, plazo aún sin cumplir (entre paréntesis, sesiones transcurridas). † ticker evaluado más de una vez.*",
    detailHead: "| Fecha | Ticker | Bloque | Resultado | Motivo | Cierre base | ",
    detailHorizon: (h) => `${h} sesiones | Exceso ${h}s`,
    noData: "sin datos",
    pending: "pendiente",
    repeated: (tickers) => [
      `† Evaluados más de una vez: ${tickers}. Cada evaluación cuenta como una observación,`,
      "pero comparten valor y no son del todo independientes.",
    ],
    noHistory: (tickers) => `Sin histórico utilizable en Yahoo: ${tickers}.`,
    reasons: {
      filter0Failed: "No supera el filtro 0",
      filter0Borderline: "Filtro 0 al límite",
      criteriaNotMet: "Supera el filtro 0, no los criterios",
      driverCovered: "Driver ya cubierto en watchlist",
      badData: "Datos insuficientes o dudosos",
      downtrend: "Tendencia bajista",
      nearHighs: "Cerca de máximos (criterio previo)",
      notEnoughCriteria: "No suma criterios suficientes",
      other: "Otro (ver resumen)",
    },
  },

  screening: {
    candidateHeader: (ticker, name, conviction, selection) =>
      `${ticker} — ${name}  [convicción: ${conviction}${selection ? ` · ${selection}` : ""}]`,
    setupLine: (setup) => `Setup: ${setup}`,
    parseFailed: "Error al parsear la respuesta de Claude",
    noReason: "Sin respuesta",
    buyOnlyWithSetup:
      "Se comprará solo con un setup: el heartbeat busca cada día un retroceso o una ruptura (ADR-0013).",
    nextCatalyst: (catalyst) => `Próximo catalizador: ${catalyst}`,
    exitReasons: {
      out_of_universe: "fuera del universo",
      filter_zero: "rompe el filtro 0",
      out_of_top: "fuera de la mitad superior del ranking",
      no_setup: "sin setup",
    },
    exitDetails: {
      notInUniverse: "no está en screening-universe.md",
      rankPosition: (rank, size, currency) => `puesto ${rank} de ${size} en el silo ${currency}`,
      noSetupWeeks: (weeks) => `sin setup en las últimas ${weeks} semanas`,
    },
    exitArchiveReason: (date, detail) => `Salida mecánica ${date}: ${detail}`,
    rankingFallback: {
      noReferenceHistory: (ticker) => `sin histórico reciente de la referencia ${ticker}`,
      lowCoverage: (withData, total) => `solo ${withData} de ${total} valores con datos`,
      staleMedian: (date) => `la última sesión mediana del universo es ${date ?? "ninguna"}`,
    },
    noRanking: (reason) => [
      `⚠️  SIN RANKING: ${reason}. Los candidatos se sortearon como antes de existir el ranking,`,
      "    solo entre los que pasan el filtro 0 (ADR-0012).",
    ],
    siloWithoutCandidates: (currency, cause) => `⚠️  SILO ${currency} SIN CANDIDATOS: ${cause}.`,
    noDrawnPassesFilter: "ningún valor sorteado del silo pasa el filtro 0",
    noneEligible: "ningún valor del silo pasa el filtro 0",
    allEligibleTaken: (eligible) => `los ${eligible} elegibles del ranking están en watchlist o descartados hace poco`,
    exploration: "exploración",
    rankingLabel: (rank) => `ranking #${rank}`,
    subjectAdded: (added) => `[Finance Agent] Screening — ${added} nuevo(s) en watchlist`,
    subjectNoneAdded: (analyzed) => `[Finance Agent] Screening — ${analyzed} analizados, ninguno añadido`,
    emailTitle: (today) => `Finance Agent — Weekly Screening (${today})`,
    counts: (analyzed, added, rejected) =>
      `Analizados: ${analyzed} | Añadidos a watchlist: ${added} | Descartados: ${rejected}`,
    overdueReview: (date) => [
      `⚠️  RECORDATORIO: screening-universe.md tiene next_review=${date} (ya vencido).`,
      "    Revisar y actualizar la lista del universo.",
    ],
    unresolved: (count, tickers) => [
      `⚠️  ATENCIÓN: ${count} candidato(s) quedaron sin resolver en logs/pending-screening/:`,
      `    ${tickers}`,
    ],
    withSetupTitle: "── CON SETUP ACTIVO O ARMADO ──────────────────────────────────",
    toWatchTitle: "── VIGILAR ────────────────────────────────────────────────────",
    addedTitle: "── AÑADIDOS A WATCHLIST (motivo) ─────────────────────────────",
    retiredTitle: "── RETIRADOS DE LA WATCHLIST ───────────────────────────────────",
    rejectedTitle: "── DESCARTADOS ──────────────────────────────────────────────",
    pendingExitCriteria: (tickers) => [
      "── RECORDATORIO: TESIS SIN CRITERIO DE SALIDA ───────────────────",
      `Estas tesis activas aún no tienen definido "Cuándo dejaría de ser válida": ${tickers}.`,
      "Al rellenarlo, quita `exit_criteria: pending` del frontmatter de la tesis o el recordatorio seguirá saliendo.",
    ],
    footer: [
      "Este es un resumen automático del Finance Agent.",
      "Los valores añadidos ya están en watchlist.md y serán monitorizados en el próximo heartbeat.",
      "NOTA: La inclusión en watchlist es automática; revisa y ajusta umbrales si es necesario.",
    ],
  },

  briefing: {
    emailTitle: (today) => `[Finance Agent] Monday Briefing — ${today}`,
    subject: (today, plan) => `[Finance Agent] Monday Briefing ${today} — ${plan}`,
    planFallback: "ver informe completo",
    retired: (tickers) => `Retiros automáticos de watchlist: ${tickers}`,
    noneRetired: "Sin retiros automáticos de watchlist esta semana.",
    retireReason: (today) => `Monday Briefing ${today}: tesis invalidada`,
    macroSearchWarning:
      "> ⚠ Aviso automático: la búsqueda web no devolvió resultados en este run (bloqueada, agotada o sin uso) — el contexto de esta sección puede basarse solo en conocimiento entrenado, no en tiempo real.\n",
    ticketsTitle: "## Tickets del motor",
    ticketsNote: "Importe de venta y trailing stop los calcula el motor (ADR-0009). Lo bloqueado no se ejecuta.",
    proposed: "PROPUESTA",
    blocked: (codes) => `BLOQUEADA (${codes})`,
    ticketHeader: ["| Campo | Valor |", "|---|---|"],
    noTicket: "Sin ticket: el motor no pudo calcularlo.",
  },

  decisionLog: {
    decisionTitle: "## Decisión",
    fieldHeader: ["| Campo | Valor |", "|---|---|"],
    action: "Acción",
    conviction: "Convicción",
    setup: "Setup",
    setupValue: (pattern, level, target) => `${pattern} a ${level}, objetivo ${target}`,
    triggers: "Disparos",
    rangePosition: "Posición en rango",
    bias: "Sesgo",
    ticketTitle: "## Ticket",
    direction: "Dirección",
    referencePrice: "Precio de referencia",
    proposedTarget: "Objetivo propuesto",
    block: "Bloqueo",
    assumptionsTitle: "## Supuestos",
    noticesTitle: "## Avisos",
    thesisTitle: "## Tesis",
  },

  thesis: {
    title: (ticker, name) => `Tesis ${ticker} — ${name}`,
    investmentThesis: "## Tesis de inversión",
    thesisPending: "(tesis pendiente de elaborar)",
    technicalAnalysis: (date) => `## Análisis técnico (screening ${date})`,
    nextCatalyst: "## Próximo catalizador",
    entryTitle: "## Entrada",
    entry: "Solo con un setup del heartbeat (retroceso o ruptura, ADR-0013); stop y tamaño los calcula el motor.",
    invalidationTitle: "## Cuándo dejaría de ser válida",
    exitCriteriaPending: "(pendiente de definir: rellenar y quitar `exit_criteria: pending` del frontmatter)",
    referencesTitle: "## Referencias",
    references: [
      "- `watchlist.md` — activos vigilados",
      "- `architecture/decisions/0017-setups-de-entrada.md` — cuándo se compra",
    ],
  },

  twoMonthRule: (ticker, pnl, currency, date, until) =>
    `Regla de los dos meses (art. 33.5.f LIRPF): ${ticker} se vendió con pérdida (${pnl} ${currency}) el ${date}. ` +
    `Recomprar antes del ${until} difiere esa pérdida.`,
};
