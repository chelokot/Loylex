export const leylobucksInitialQuizSize = 5;

export const leylobucksPackages = [
  { cost: 100, messages: 1 },
  { cost: 250, messages: 3 },
  { cost: 500, messages: 10 },
] as const;

export type LeylobucksPackage = (typeof leylobucksPackages)[number];

export type LeylobucksQuizQuestion = {
  id: string;
  category: string;
  prompt: string;
  options: readonly string[];
  correctIndex: number;
};

const quizQuestions: readonly LeylobucksQuizQuestion[] = [
  {
    id: "geography-gibraltar",
    category: "география",
    prompt: "Какой пролив отделяет Европу от Африки?",
    options: ["Босфор", "Гибралтарский", "Ла-Манш", "Дарданеллы"],
    correctIndex: 1,
  },
  {
    id: "geography-australia",
    category: "география",
    prompt: "Какой город является столицей Австралии?",
    options: ["Сидней", "Мельбурн", "Канберра", "Перт"],
    correctIndex: 2,
  },
  {
    id: "geography-landlocked",
    category: "география",
    prompt: "Какое из этих государств не имеет выхода к морю?",
    options: ["Боливия", "Чили", "Эквадор", "Колумбия"],
    correctIndex: 0,
  },
  {
    id: "geography-baikal",
    category: "география",
    prompt: "В какой части России находится озеро Байкал?",
    options: ["Восточная Сибирь", "Северный Кавказ", "Нижнее Поволжье", "Карелия"],
    correctIndex: 0,
  },
  {
    id: "math-roots",
    category: "математика",
    prompt: "Какие корни уравнения x² − 5x + 6 = 0?",
    options: ["1 и 6", "2 и 3", "−2 и −3", "0 и 5"],
    correctIndex: 1,
  },
  {
    id: "math-progression",
    category: "математика",
    prompt: "Чему равен десятый член арифметической прогрессии 4, 7, 10, ...?",
    options: ["28", "31", "34", "37"],
    correctIndex: 1,
  },
  {
    id: "math-dice",
    category: "математика",
    prompt: "Какова вероятность выбросить сумму 7 при броске двух обычных кубиков?",
    options: ["1/12", "1/6", "1/4", "1/3"],
    correctIndex: 1,
  },
  {
    id: "math-modulo",
    category: "математика",
    prompt: "Чему равен остаток от деления 2¹⁰ на 7?",
    options: ["0", "1", "2", "4"],
    correctIndex: 2,
  },
  {
    id: "physics-force",
    category: "физика",
    prompt: "Тело движется прямолинейно и равномерно. Чему равна равнодействующая сил?",
    options: ["Нулю", "Силе тяжести", "Силе трения", "Она обязательно растёт"],
    correctIndex: 0,
  },
  {
    id: "physics-resistors",
    category: "физика",
    prompt: "Каково сопротивление двух резисторов 2 Ом и 3 Ом, соединённых последовательно?",
    options: ["0,5 Ом", "1,2 Ом", "5 Ом", "6 Ом"],
    correctIndex: 2,
  },
  {
    id: "physics-pendulum",
    category: "физика",
    prompt: "От чего в идеальном приближении зависит период математического маятника?",
    options: [
      "От массы груза",
      "От длины и ускорения свободного падения",
      "Только от амплитуды",
      "Только от плотности груза",
    ],
    correctIndex: 1,
  },
  {
    id: "physics-energy",
    category: "физика",
    prompt: "Какая величина сохраняется в замкнутой системе при упругом столкновении?",
    options: [
      "Только скорость",
      "Только кинетическая энергия",
      "Импульс и кинетическая энергия",
      "Только сила",
    ],
    correctIndex: 2,
  },
  {
    id: "biology-mitochondria",
    category: "биология",
    prompt: "Какую основную функцию выполняют митохондрии?",
    options: [
      "Синтезируют большую часть клеточной энергии",
      "Хранят наследственный код",
      "Переваривают пищу вне организма",
      "Образуют клеточную стенку",
    ],
    correctIndex: 0,
  },
  {
    id: "biology-blood",
    category: "биология",
    prompt: "Какая группа крови обычно обозначается как AB (IV)?",
    options: ["Только антиген A", "Только антиген B", "Антигены A и B", "Ни одного антигена"],
    correctIndex: 2,
  },
  {
    id: "biology-pcr",
    category: "биология",
    prompt: "Что именно многократно копирует метод ПЦР?",
    options: ["Белки", "Участок ДНК", "Жиры", "Клеточные мембраны"],
    correctIndex: 1,
  },
  {
    id: "biology-selection",
    category: "биология",
    prompt: "Что в первую очередь меняет естественный отбор в популяции?",
    options: [
      "Частоты наследуемых признаков",
      "Возраст всех особей",
      "Состав горных пород",
      "Скорость вращения планеты",
    ],
    correctIndex: 0,
  },
  {
    id: "history-magna-carta",
    category: "история",
    prompt: "В каком году была подписана английская Великая хартия вольностей?",
    options: ["1066", "1215", "1492", "1648"],
    correctIndex: 1,
  },
  {
    id: "history-constantinople",
    category: "история",
    prompt: "Какое событие произошло в 1453 году?",
    options: [
      "Открытие Америки Колумбом",
      "Падение Константинополя",
      "Начало Реформации",
      "Битва при Ватерлоо",
    ],
    correctIndex: 1,
  },
  {
    id: "history-industrial",
    category: "история",
    prompt: "В какой стране раньше всего началась промышленная революция?",
    options: ["Великобритания", "Испания", "Япония", "Бразилия"],
    correctIndex: 0,
  },
  {
    id: "history-westphalia",
    category: "история",
    prompt: "Вестфальский мир 1648 года прежде всего завершил какой конфликт?",
    options: ["Столетнюю войну", "Тридцатилетнюю войну", "Крымскую войну", "Семилетнюю войну"],
    correctIndex: 1,
  },
  {
    id: "astronomy-seasons",
    category: "астрономия",
    prompt: "Почему на Земле сменяются времена года?",
    options: [
      "Из-за изменения расстояния до Солнца каждый день",
      "Из-за наклона оси Земли при обращении вокруг Солнца",
      "Из-за фаз Луны",
      "Из-за солнечных затмений",
    ],
    correctIndex: 1,
  },
  {
    id: "astronomy-redshift",
    category: "астрономия",
    prompt: "Что обычно означает космологическое красное смещение далёких галактик?",
    options: [
      "Галактика обязательно остывает",
      "Галактика удаляется относительно наблюдателя",
      "Звёзды в ней стали синими",
      "Галактика перестала вращаться",
    ],
    correctIndex: 1,
  },
  {
    id: "astronomy-main-sequence",
    category: "астрономия",
    prompt: "Какой процесс даёт основную энергию звезде главной последовательности?",
    options: [
      "Сжигание угля",
      "Ядерный синтез водорода в гелий",
      "Падение метеоритов",
      "Отражение света планет",
    ],
    correctIndex: 1,
  },
  {
    id: "astronomy-moon-phases",
    category: "астрономия",
    prompt: "Чем в основном объясняются фазы Луны?",
    options: [
      "Изменением размера Луны",
      "Изменением видимой освещённой части Луны",
      "Тенями облаков Земли каждую ночь",
      "Изменением яркости Солнца",
    ],
    correctIndex: 1,
  },
  {
    id: "politics-separation",
    category: "политика",
    prompt: "Какую идею выражает принцип разделения властей?",
    options: [
      "Все решения принимает один орган",
      "Ветви власти взаимно ограничивают друг друга",
      "Выборы не нужны",
      "Суд подчиняется любой партии",
    ],
    correctIndex: 1,
  },
  {
    id: "politics-proportional",
    category: "политика",
    prompt: "Что в общих чертах означает пропорциональная избирательная система?",
    options: [
      "Места распределяются примерно согласно доле голосов списков",
      "Побеждает только кандидат с одним голосом",
      "Голосуют только судьи",
      "Результат определяет случайная жеребьёвка",
    ],
    correctIndex: 0,
  },
  {
    id: "politics-un",
    category: "политика",
    prompt: "Сколько постоянных членов у Совета Безопасности ООН?",
    options: ["3", "5", "7", "10"],
    correctIndex: 1,
  },
  {
    id: "politics-budget",
    category: "политика",
    prompt: "Какую роль обычно играет парламент при принятии государственного бюджета?",
    options: [
      "Утверждает правила движения планет",
      "Рассматривает и утверждает публичные доходы и расходы",
      "Назначает всех граждан на работу",
      "Отменяет законы физики",
    ],
    correctIndex: 1,
  },
  {
    id: "chemistry-ph",
    category: "химия",
    prompt: "Какой раствор является кислым при комнатной температуре?",
    options: ["pH 2", "pH 7", "pH 9", "pH 12"],
    correctIndex: 0,
  },
  {
    id: "chemistry-avogadro",
    category: "химия",
    prompt: "Что примерно равно постоянной Авогадро?",
    options: ["6,02 × 10²³ частиц на моль", "9,81 м/с²", "3 × 10⁸ м/с", "1,60 × 10⁻¹⁹ Кл"],
    correctIndex: 0,
  },
  {
    id: "chemistry-rust",
    category: "химия",
    prompt: "Что происходит с железом при образовании обычной ржавчины?",
    options: [
      "Оно окисляется",
      "Оно превращается в чистый углерод",
      "Оно испаряется",
      "Оно становится благородным газом",
    ],
    correctIndex: 0,
  },
  {
    id: "chemistry-benzene",
    category: "химия",
    prompt: "К какому классу органических соединений относится бензол?",
    options: ["Ароматические углеводороды", "Щёлочные металлы", "Белки", "Ионные соли"],
    correctIndex: 0,
  },
] as const;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}

function normalizedText(value: string): string {
  return value
    .toLocaleLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function words(value: string): string[] {
  return normalizedText(value).split(/\s+/u).filter(Boolean);
}

function containsAny(value: string, candidates: readonly string[]): boolean {
  return candidates.some((candidate) => value.includes(candidate));
}

export type LeylobucksAssessment = {
  qualityScore: number;
  delta: number;
};

export function assessLeylobucksRequest(
  text: string,
  previousTexts: readonly string[] = [],
): LeylobucksAssessment {
  const normalized = normalizedText(text);
  if (!normalized) {
    return { qualityScore: 5, delta: -90 };
  }

  const textWords = words(text);
  const uniqueWords = new Set(textWords).size;
  let quality = 36;
  if (textWords.length >= 3) quality += 8;
  if (textWords.length >= 8) quality += 8;
  if (textWords.length >= 18) quality += 8;
  if (/[?!。？！]/u.test(text)) quality += 5;
  if (
    containsAny(normalized, [
      "проверь",
      "объясни",
      "сравни",
      "найди",
      "сделай",
      "напиши",
      "помоги",
      "разбери",
      "почему",
      "как",
      "план",
      "check",
      "explain",
      "compare",
      "find",
      "build",
      "write",
      "how",
      "why",
    ])
  ) {
    quality += 10;
  }
  if (
    containsAny(normalized, [
      "потому",
      "контекст",
      "огранич",
      "формат",
      "результат",
      "срок",
      "критер",
      "пример",
      "ошиб",
      "контекст",
      "because",
      "constraint",
      "format",
      "result",
    ])
  ) {
    quality += 10;
  }
  if (textWords.length > 4 && uniqueWords / textWords.length >= 0.75) {
    quality += 5;
  }
  if (/([!?])\1{2,}/u.test(text) || /(.)\1{4,}/u.test(normalized)) {
    quality -= 25;
  }
  if (textWords.length <= 2) {
    quality -= 12;
  }
  if (/^[\p{So}\p{Sk}\s]+$/u.test(text)) {
    quality -= 25;
  }
  if (text.length >= 80 && text.length <= 2_000) {
    quality += 5;
  }
  if (
    previousTexts.some((previous) => {
      const normalizedPrevious = normalizedText(previous);
      return normalizedPrevious.length > 0 && normalizedPrevious === normalized;
    })
  ) {
    quality -= 30;
  }

  const qualityScore = clamp(Math.round(quality), 0, 100);
  const delta = qualityScore === 50 ? 0 : (qualityScore - 50) * 2;
  return { qualityScore, delta: clamp(delta, -100, 100) };
}

function stableSeed(userId: number, attempt: number): number {
  let hash = (userId ^ (attempt * 2_654_435_761)) >>> 0;
  for (const character of `${userId}:${attempt}`) {
    hash = Math.imul(hash ^ (character.codePointAt(0) ?? 0), 1_664_525) + 1_013_904_223;
  }
  return hash >>> 0;
}

function questionCategories(): string[] {
  return [...new Set(quizQuestions.map((question) => question.category))];
}

export function createLeylobucksQuiz(
  userId: number,
  attempt: number,
  questionCount: number,
): LeylobucksQuizQuestion[] {
  const categories = questionCategories();
  const byCategory = new Map<string, LeylobucksQuizQuestion[]>();
  for (const question of quizQuestions) {
    const category = byCategory.get(question.category) ?? [];
    category.push(question);
    byCategory.set(question.category, category);
  }
  const seed = stableSeed(userId, attempt);
  const questions: LeylobucksQuizQuestion[] = [];
  for (let index = 0; index < questionCount; index += 1) {
    const category = categories[(seed + index) % categories.length] ?? "";
    if (!category) {
      continue;
    }
    const categoryQuestions = byCategory.get(category) ?? [];
    const cycle = Math.floor(index / categories.length);
    const question =
      categoryQuestions[(Math.floor(seed / categories.length) + cycle) % categoryQuestions.length];
    if (question) {
      questions.push(question);
    }
  }
  return questions;
}

export function quizPassingScore(questionCount: number): number {
  return Math.max(1, questionCount - 1);
}

export function quizAnswerIndex(input: string, question: LeylobucksQuizQuestion): number | null {
  const normalized = input
    .trim()
    .toLocaleLowerCase()
    .replace(/^(?:ответ|answer)\s*/u, "")
    .trim();
  const letter = normalized.match(/^([abcdавг])(?:[).:,-]|\s|$)/u)?.[1];
  if (letter) {
    const index = { а: 0, a: 0, б: 1, b: 1, в: 2, c: 2, г: 3, d: 3 }[letter];
    return index === undefined ? null : index;
  }
  const number = normalized.match(/^([1-4])(?:[).:,-]|\s|$)/u)?.[1];
  if (number) {
    return Number(number) - 1;
  }
  const exact = question.options.findIndex(
    (option) => normalizedText(option) === normalizedText(normalized),
  );
  return exact >= 0 ? exact : null;
}
