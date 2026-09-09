export const leylobucksInitialQuizSize = 5;

export const leylobucksPackages = [
  { cost: 100, messages: 1 },
  { cost: 250, messages: 3 },
  { cost: 500, messages: 10 },
] as const;

export type LeylobucksPackage = (typeof leylobucksPackages)[number];

export type LeylobucksQuizDifficulty = "easy" | "medium" | "hard";

export type LeylobucksQuizQuestion = {
  id: string;
  category: string;
  difficulty: LeylobucksQuizDifficulty;
  prompt: string;
  options: readonly string[];
  correctIndex: number;
};

export const leylobucksQuizQuestions: readonly LeylobucksQuizQuestion[] = [
  {
    id: "geography-gibraltar",
    category: "география",
    difficulty: "medium",
    prompt: "Какой пролив отделяет Европу от Африки?",
    options: ["Босфор", "Гибралтарский", "Ла-Манш", "Дарданеллы"],
    correctIndex: 1,
  },
  {
    id: "geography-australia",
    category: "география",
    difficulty: "easy",
    prompt: "Какой город является столицей Австралии?",
    options: ["Сидней", "Мельбурн", "Канберра", "Перт"],
    correctIndex: 2,
  },
  {
    id: "geography-landlocked",
    category: "география",
    difficulty: "easy",
    prompt: "Какое из этих государств не имеет выхода к морю?",
    options: ["Боливия", "Чили", "Эквадор", "Колумбия"],
    correctIndex: 0,
  },
  {
    id: "geography-baikal",
    category: "география",
    difficulty: "medium",
    prompt: "В какой части России находится озеро Байкал?",
    options: ["Восточная Сибирь", "Северный Кавказ", "Нижнее Поволжье", "Карелия"],
    correctIndex: 0,
  },
  {
    id: "math-roots",
    category: "математика",
    difficulty: "easy",
    prompt: "Какие корни уравнения x² − 5x + 6 = 0?",
    options: ["1 и 6", "2 и 3", "−2 и −3", "0 и 5"],
    correctIndex: 1,
  },
  {
    id: "math-progression",
    category: "математика",
    difficulty: "medium",
    prompt: "Чему равен десятый член арифметической прогрессии 4, 7, 10, ...?",
    options: ["28", "31", "34", "37"],
    correctIndex: 1,
  },
  {
    id: "math-dice",
    category: "математика",
    difficulty: "hard",
    prompt: "Какова вероятность выбросить сумму 7 при броске двух обычных кубиков?",
    options: ["1/12", "1/6", "1/4", "1/3"],
    correctIndex: 1,
  },
  {
    id: "math-modulo",
    category: "математика",
    difficulty: "hard",
    prompt: "Чему равен остаток от деления 2¹⁰ на 7?",
    options: ["0", "1", "2", "4"],
    correctIndex: 2,
  },
  {
    id: "physics-force",
    category: "физика",
    difficulty: "easy",
    prompt: "Тело движется прямолинейно и равномерно. Чему равна равнодействующая сил?",
    options: ["Нулю", "Силе тяжести", "Силе трения", "Она обязательно растёт"],
    correctIndex: 0,
  },
  {
    id: "physics-resistors",
    category: "физика",
    difficulty: "medium",
    prompt: "Каково сопротивление двух резисторов 2 Ом и 3 Ом, соединённых последовательно?",
    options: ["0,5 Ом", "1,2 Ом", "5 Ом", "6 Ом"],
    correctIndex: 2,
  },
  {
    id: "physics-pendulum",
    category: "физика",
    difficulty: "hard",
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
    difficulty: "hard",
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
    difficulty: "easy",
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
    difficulty: "medium",
    prompt: "Какая группа крови обычно обозначается как AB (IV)?",
    options: ["Только антиген A", "Только антиген B", "Антигены A и B", "Ни одного антигена"],
    correctIndex: 2,
  },
  {
    id: "biology-pcr",
    category: "биология",
    difficulty: "medium",
    prompt: "Что именно многократно копирует метод ПЦР?",
    options: ["Белки", "Участок ДНК", "Жиры", "Клеточные мембраны"],
    correctIndex: 1,
  },
  {
    id: "biology-selection",
    category: "биология",
    difficulty: "hard",
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
    difficulty: "medium",
    prompt: "В каком году была подписана английская Великая хартия вольностей?",
    options: ["1066", "1215", "1492", "1648"],
    correctIndex: 1,
  },
  {
    id: "history-constantinople",
    category: "история",
    difficulty: "easy",
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
    difficulty: "medium",
    prompt: "В какой стране раньше всего началась промышленная революция?",
    options: ["Великобритания", "Испания", "Япония", "Бразилия"],
    correctIndex: 0,
  },
  {
    id: "history-westphalia",
    category: "история",
    difficulty: "hard",
    prompt: "Вестфальский мир 1648 года прежде всего завершил какой конфликт?",
    options: ["Столетнюю войну", "Тридцатилетнюю войну", "Крымскую войну", "Семилетнюю войну"],
    correctIndex: 1,
  },
  {
    id: "astronomy-seasons",
    category: "астрономия",
    difficulty: "easy",
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
    difficulty: "hard",
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
    difficulty: "hard",
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
    difficulty: "medium",
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
    difficulty: "medium",
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
    difficulty: "hard",
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
    difficulty: "medium",
    prompt: "Сколько постоянных членов у Совета Безопасности ООН?",
    options: ["3", "5", "7", "10"],
    correctIndex: 1,
  },
  {
    id: "politics-budget",
    category: "политика",
    difficulty: "hard",
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
    difficulty: "easy",
    prompt: "Какой раствор является кислым при комнатной температуре?",
    options: ["pH 2", "pH 7", "pH 9", "pH 12"],
    correctIndex: 0,
  },
  {
    id: "chemistry-avogadro",
    category: "химия",
    difficulty: "medium",
    prompt: "Что примерно равно постоянной Авогадро?",
    options: ["6,02 × 10²³ частиц на моль", "9,81 м/с²", "3 × 10⁸ м/с", "1,60 × 10⁻¹⁹ Кл"],
    correctIndex: 0,
  },
  {
    id: "chemistry-rust",
    category: "химия",
    difficulty: "easy",
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
    difficulty: "hard",
    prompt: "К какому классу органических соединений относится бензол?",
    options: ["Ароматические углеводороды", "Щёлочные металлы", "Белки", "Ионные соли"],
    correctIndex: 0,
  },
  {
    id: "geography-pacific-ocean",
    category: "география",
    difficulty: "easy",
    prompt: "Какой океан занимает крупнейшую площадь на Земле?",
    options: ["Тихий", "Атлантический", "Индийский", "Северный Ледовитый"],
    correctIndex: 0,
  },
  {
    id: "geography-prime-meridian",
    category: "география",
    difficulty: "easy",
    prompt: "Как называется условная линия 0° долготы?",
    options: ["Экватор", "Гринвичский меридиан", "Тропик Рака", "Северный полярный круг"],
    correctIndex: 1,
  },
  {
    id: "geography-contours",
    category: "география",
    difficulty: "medium",
    prompt: "Что соединяют горизонтали (изогипсы) на топографической карте?",
    options: [
      "Точки с одинаковой абсолютной высотой",
      "Точки с одинаковой температурой",
      "Источники одного и того же полезного ископаемого",
      "Границы часовых поясов",
    ],
    correctIndex: 0,
  },
  {
    id: "geography-coriolis",
    category: "география",
    difficulty: "hard",
    prompt: "Почему крупные воздушные массы отклоняются от прямолинейного движения?",
    options: [
      "Из-за магнитного поля Солнца",
      "Из-за вращения Земли и силы Кориолиса",
      "Из-за приливов и отливов",
      "Из-за разницы солёности океанов",
    ],
    correctIndex: 1,
  },
  {
    id: "math-logarithm",
    category: "математика",
    difficulty: "easy",
    prompt: "Чему равен логарифм log₂ 8?",
    options: ["2", "3", "4", "8"],
    correctIndex: 1,
  },
  {
    id: "math-determinant",
    category: "математика",
    difficulty: "medium",
    prompt: "Чему равен определитель матрицы [[1, 2], [3, 4]]?",
    options: ["−2", "−1", "2", "10"],
    correctIndex: 0,
  },
  {
    id: "math-binary-search",
    category: "математика",
    difficulty: "hard",
    prompt: "Какова асимптотическая сложность бинарного поиска в отсортированном массиве?",
    options: ["O(1)", "O(log n)", "O(n)", "O(n²)"],
    correctIndex: 1,
  },
  {
    id: "math-basel",
    category: "математика",
    difficulty: "hard",
    prompt: "Чему равна сумма 1 + 1/4 + 1/9 + 1/16 + …?",
    options: ["π/6", "π²/6", "2π", "1"],
    correctIndex: 1,
  },
  {
    id: "physics-newton",
    category: "физика",
    difficulty: "easy",
    prompt: "Как называется единица силы в Международной системе единиц?",
    options: ["Ньютон", "Джоуль", "Паскаль", "Ватт"],
    correctIndex: 0,
  },
  {
    id: "physics-refraction",
    category: "физика",
    difficulty: "medium",
    prompt: "Что происходит с частотой волны при переходе в другую среду?",
    options: [
      "Она всегда становится вдвое больше",
      "Она сохраняется, а скорость и длина волны могут измениться",
      "Она исчезает",
      "Она меняется только у звуковых волн",
    ],
    correctIndex: 1,
  },
  {
    id: "physics-magnetic-gauss",
    category: "физика",
    difficulty: "hard",
    prompt: "Что утверждает закон Гаусса для магнетизма?",
    options: [
      "Электрический заряд всегда равен нулю",
      "Магнитный поток через замкнутую поверхность равен нулю",
      "Магнитное поле существует только в вакууме",
      "Сила тока не зависит от напряжения",
    ],
    correctIndex: 1,
  },
  {
    id: "physics-time-dilation",
    category: "физика",
    difficulty: "hard",
    prompt: "Как называется релятивистский эффект, при котором движущиеся часы идут медленнее?",
    options: ["Интерференция", "Замедление времени", "Дифракция", "Поляризация"],
    correctIndex: 1,
  },
  {
    id: "biology-base-pairs",
    category: "биология",
    difficulty: "easy",
    prompt: "Какие пары комплементарных оснований образуются в ДНК?",
    options: ["A–T и C–G", "A–C и T–G", "A–G и C–T", "A–U и C–G"],
    correctIndex: 0,
  },
  {
    id: "biology-osmosis",
    category: "биология",
    difficulty: "easy",
    prompt: "Что называют осмосом?",
    options: [
      "Движение воды через полупроницаемую мембрану к более концентрированному раствору",
      "Синтез белка на рибосоме",
      "Деление ядра клетки",
      "Поглощение света хлорофиллом",
    ],
    correctIndex: 0,
  },
  {
    id: "biology-promoter",
    category: "биология",
    difficulty: "medium",
    prompt: "Какую роль обычно выполняет промотор в гене?",
    options: [
      "Разрушает готовую белковую молекулу",
      "Служит участком связывания РНК-полимеразы для начала транскрипции",
      "Переносит аминокислоты к рибосоме",
      "Запасает энергию в виде АТФ",
    ],
    correctIndex: 1,
  },
  {
    id: "biology-crispr-cas9",
    category: "биология",
    difficulty: "hard",
    prompt: "Какую функцию выполняет направляющая РНК в классической системе CRISPR-Cas9?",
    options: [
      "Синтезирует липиды клеточной мембраны",
      "Ускоряет дыхание клетки",
      "Направляет Cas9 к комплементарному участку ДНК для разрезания",
      "Заменяет рибосому при делении клетки",
    ],
    correctIndex: 2,
  },
  {
    id: "history-gutenberg",
    category: "история",
    difficulty: "easy",
    prompt:
      "С чьим именем обычно связывают распространение книгопечатания подвижными литерами в Европе?",
    options: ["Иоганн Гутенберг", "Николай Коперник", "Леонардо да Винчи", "Марко Поло"],
    correctIndex: 0,
  },
  {
    id: "history-bretton-woods",
    category: "история",
    difficulty: "medium",
    prompt: "Какая конференция 1944 года заложила основы МВФ и Всемирного банка?",
    options: ["Ялтинская", "Бреттон-Вудская", "Потсдамская", "Лозаннская"],
    correctIndex: 1,
  },
  {
    id: "history-nuremberg-principle",
    category: "история",
    difficulty: "hard",
    prompt: "Какой принцип международного права особенно закрепился после Нюрнбергского процесса?",
    options: [
      "Физические лица могут нести ответственность за международные преступления",
      "Государства не отвечают за действия армий",
      "Военные преступления теряют силу через год",
      "Международные суды рассматривают только торговые споры",
    ],
    correctIndex: 0,
  },
  {
    id: "astronomy-light-year",
    category: "астрономия",
    difficulty: "easy",
    prompt: "Что измеряет световой год?",
    options: ["Расстояние", "Время вращения Земли", "Яркость звезды", "Массу галактики"],
    correctIndex: 0,
  },
  {
    id: "astronomy-spectroscopy",
    category: "астрономия",
    difficulty: "medium",
    prompt: "Что по спектральным линиям звезды можно узнать наиболее непосредственно?",
    options: [
      "Только её диаметр",
      "Только число планет",
      "Химический состав и движение относительно наблюдателя",
      "Точный возраст каждого астероида рядом с ней",
    ],
    correctIndex: 2,
  },
  {
    id: "astronomy-gravitational-lensing",
    category: "астрономия",
    difficulty: "hard",
    prompt: "Что вызывает гравитационное линзирование?",
    options: [
      "Поглощение света межзвёздной пылью",
      "Искривление и иногда усиление света массивным объектом",
      "Изменение химического состава фотонов",
      "Вращение Земли вокруг своей оси",
    ],
    correctIndex: 1,
  },
  {
    id: "politics-constitution",
    category: "политика",
    difficulty: "easy",
    prompt: "Что обычно определяет конституция государства?",
    options: [
      "Основы устройства власти и базовые права граждан",
      "Только расписание общественного транспорта",
      "Только цены на товары",
      "Только состав национальной сборной",
    ],
    correctIndex: 0,
  },
  {
    id: "politics-median-voter",
    category: "политика",
    difficulty: "medium",
    prompt:
      "Что предсказывает теорема медианного избирателя в простой одномерной модели голосования?",
    options: [
      "Все избиратели голосуют случайно",
      "Кандидаты стремятся приблизиться к позиции медианного избирателя",
      "Побеждает всегда самый молодой кандидат",
      "Партии не меняют свои позиции",
    ],
    correctIndex: 1,
  },
  {
    id: "politics-free-rider",
    category: "политика",
    difficulty: "hard",
    prompt:
      "Как называется проблема, когда человек пользуется общественным благом, не участвуя в его финансировании?",
    options: [
      "Эффект якоря",
      "Парадокс голосования",
      "Проблема безбилетника",
      "Эффект наблюдателя",
    ],
    correctIndex: 2,
  },
  {
    id: "chemistry-atomic-number",
    category: "химия",
    difficulty: "easy",
    prompt: "Что показывает атомный номер элемента?",
    options: ["Число нейтронов", "Число протонов", "Массу электрона", "Число молекул в образце"],
    correctIndex: 1,
  },
  {
    id: "chemistry-covalent-bond",
    category: "химия",
    difficulty: "easy",
    prompt: "Что образует ковалентную химическую связь?",
    options: [
      "Общая электронная пара атомов",
      "Только свободные нейтроны",
      "Обязательный обмен протонами",
      "Гравитационное поле планеты",
    ],
    correctIndex: 0,
  },
  {
    id: "chemistry-buffer",
    category: "химия",
    difficulty: "medium",
    prompt: "Какое свойство характерно для буферного раствора?",
    options: [
      "Он всегда имеет pH ровно 7",
      "Он сопротивляется заметному изменению pH при добавлении небольшого количества кислоты или основания",
      "Он не содержит растворённых веществ",
      "Он превращает любой металл в газ",
    ],
    correctIndex: 1,
  },
  {
    id: "technology-easy-html-link",
    category: "технологии",
    difficulty: "easy",
    prompt: "Какой HTML-тег обычно создаёт гиперссылку?",
    options: ["<p>", "<a>", "<link>", "<href>"],
    correctIndex: 1,
  },
  {
    id: "technology-easy-css-color",
    category: "технологии",
    difficulty: "easy",
    prompt: "Какое CSS-свойство задаёт цвет текста?",
    options: ["background", "font-size", "color", "display"],
    correctIndex: 2,
  },
  {
    id: "technology-easy-js-strict-equality",
    category: "технологии",
    difficulty: "easy",
    prompt: "Какой оператор JavaScript сравнивает значения и типы без неявного приведения?",
    options: ["===", "=", "==", "=>"],
    correctIndex: 0,
  },
  {
    id: "technology-easy-python-list",
    category: "технологии",
    difficulty: "easy",
    prompt: "Как обычно записывается пустой список в Python?",
    options: ["{}", "()", "<>", "[]"],
    correctIndex: 3,
  },
  {
    id: "technology-easy-git-clone",
    category: "технологии",
    difficulty: "easy",
    prompt: "Какая команда Git копирует удалённый репозиторий локально?",
    options: ["git merge", "git pull", "git clone", "git init"],
    correctIndex: 2,
  },
  {
    id: "technology-easy-http-404",
    category: "технологии",
    difficulty: "easy",
    prompt: "Что обычно означает HTTP-статус 404?",
    options: ["Ошибка сервера", "Ресурс не найден", "Успешный ответ", "Ресурс перемещён"],
    correctIndex: 1,
  },
  {
    id: "technology-easy-dns",
    category: "технологии",
    difficulty: "easy",
    prompt: "Какую задачу в типичном случае решает DNS?",
    options: [
      "Компилирует код",
      "Шифрует диск",
      "Связывает доменное имя с IP-адресом",
      "Сжимает видео",
    ],
    correctIndex: 2,
  },
  {
    id: "technology-easy-ram",
    category: "технологии",
    difficulty: "easy",
    prompt: "Что обычно происходит с данными в оперативной памяти после отключения питания?",
    options: [
      "Они сохраняются навсегда",
      "Они автоматически печатаются",
      "Они переходят в BIOS",
      "Они теряются",
    ],
    correctIndex: 3,
  },
  {
    id: "technology-easy-cpu",
    category: "технологии",
    difficulty: "easy",
    prompt: "Как расшифровывается аббревиатура CPU?",
    options: [
      "Центральное процессорное устройство",
      "Устройство сетевой печати",
      "Постоянная пользовательская учётная запись",
      "Компрессор пиксельных изображений",
    ],
    correctIndex: 0,
  },
  {
    id: "technology-easy-sql-select",
    category: "технологии",
    difficulty: "easy",
    prompt: "Для чего в SQL обычно используют SELECT?",
    options: [
      "Чтобы удалить таблицу",
      "Чтобы получить данные",
      "Чтобы создать пользователя ОС",
      "Чтобы перезапустить сервер",
    ],
    correctIndex: 1,
  },
  {
    id: "technology-easy-json",
    category: "технологии",
    difficulty: "easy",
    prompt: "Что такое JSON?",
    options: [
      "Модель видеокарты",
      "Сетевой кабель",
      "Текстовый формат структурированных данных",
      "Файловая система",
    ],
    correctIndex: 2,
  },
  {
    id: "technology-easy-pwd",
    category: "технологии",
    difficulty: "easy",
    prompt: "Что показывает команда pwd в Unix-подобной системе?",
    options: [
      "Запущенные процессы",
      "Пароли пользователей",
      "Свободную видеопамять",
      "Текущий каталог",
    ],
    correctIndex: 3,
  },
  {
    id: "technology-easy-hexadecimal",
    category: "технологии",
    difficulty: "easy",
    prompt: "Какое основание у шестнадцатеричной системы счисления?",
    options: ["2", "8", "10", "16"],
    correctIndex: 3,
  },
  {
    id: "technology-easy-loop",
    category: "технологии",
    difficulty: "easy",
    prompt: "Для чего обычно нужен цикл в программе?",
    options: [
      "Для повторения блока действий",
      "Для хранения только картинок",
      "Для выключения монитора",
      "Для изменения напряжения",
    ],
    correctIndex: 0,
  },
  {
    id: "technology-easy-ipv4-bits",
    category: "технологии",
    difficulty: "easy",
    prompt: "Сколько бит содержит адрес IPv4?",
    options: ["16", "32", "64", "128"],
    correctIndex: 1,
  },
  {
    id: "technology-easy-https",
    category: "технологии",
    difficulty: "easy",
    prompt: "Что добавляет TLS в HTTPS?",
    options: [
      "Сжатие изображений",
      "Маршрутизацию пакетов",
      "Защищённый канал для HTTP",
      "Новый формат видео",
    ],
    correctIndex: 2,
  },
  {
    id: "technology-easy-gpu",
    category: "технологии",
    difficulty: "easy",
    prompt: "Для какой задачи особенно хорошо подходит GPU?",
    options: [
      "Хранение файлов без питания",
      "Массовые параллельные вычисления над графикой",
      "Маршрутизация пакетов в интернете",
      "Печать документов без драйвера",
    ],
    correctIndex: 1,
  },
  {
    id: "technology-easy-open-source",
    category: "технологии",
    difficulty: "easy",
    prompt: "Что обычно означает «open source» для программы?",
    options: [
      "Исходный код доступен по соответствующей лицензии",
      "Программа работает только онлайн",
      "Программа написана без тестов",
      "Программа обязательно бесплатна для любой цели",
    ],
    correctIndex: 0,
  },
  {
    id: "technology-easy-https-port",
    category: "технологии",
    difficulty: "easy",
    prompt: "Какой TCP-порт по умолчанию обычно связан с HTTPS?",
    options: ["21", "25", "80", "443"],
    correctIndex: 3,
  },
  {
    id: "technology-easy-ssd",
    category: "технологии",
    difficulty: "easy",
    prompt: "Какой тип накопителя обычно использует флеш-память без вращающихся пластин?",
    options: ["CRT", "HDD на магнитной ленте", "SSD", "Матричный принтер"],
    correctIndex: 2,
  },
  {
    id: "technology-medium-thread",
    category: "технологии",
    difficulty: "medium",
    prompt: "Что обычно верно о потоке выполнения по отношению к процессу?",
    options: [
      "Поток всегда имеет отдельную ОС",
      "Поток — более лёгкая единица выполнения внутри процесса",
      "Процесс не может содержать потоков",
      "Поток — это физическое ядро CPU",
    ],
    correctIndex: 1,
  },
  {
    id: "technology-medium-tcp",
    category: "технологии",
    difficulty: "medium",
    prompt: "Какое свойство обычно предоставляет TCP?",
    options: [
      "Надёжную доставку данных по порядку",
      "Только передачу широковещательных кадров",
      "Гарантированную нулевую задержку",
      "Шифрование без дополнительных протоколов",
    ],
    correctIndex: 0,
  },
  {
    id: "technology-medium-rest-stateless",
    category: "технологии",
    difficulty: "medium",
    prompt: "Что означает stateless в распространённом понимании REST?",
    options: [
      "Сервер хранит историю каждого запроса в RAM навсегда",
      "Клиент не может отправлять состояние",
      "Каждый запрос содержит контекст, нужный серверу для обработки",
      "API работает только без базы данных",
    ],
    correctIndex: 2,
  },
  {
    id: "technology-medium-sql-join",
    category: "технологии",
    difficulty: "medium",
    prompt: "Для чего обычно используют SQL JOIN?",
    options: [
      "Чтобы сжать базу данных",
      "Чтобы зашифровать пароль",
      "Чтобы остановить транзакцию",
      "Чтобы объединить связанные строки нескольких таблиц",
    ],
    correctIndex: 3,
  },
  {
    id: "technology-medium-cache",
    category: "технологии",
    difficulty: "medium",
    prompt: "Какую типичную цель преследует кэширование?",
    options: [
      "Гарантированно увеличить точность вычислений",
      "Хранить часто нужные данные ближе и быстрее получать их",
      "Удалить все копии данных",
      "Заменить права доступа",
    ],
    correctIndex: 1,
  },
  {
    id: "technology-medium-virtual-memory",
    category: "технологии",
    difficulty: "medium",
    prompt: "Что в упрощённом виде делает виртуальная память?",
    options: [
      "Использует адресное пространство и может временно опираться на диск",
      "Превращает CPU в GPU",
      "Сохраняет данные только в регистрах",
      "Отключает планировщик процессов",
    ],
    correctIndex: 0,
  },
  {
    id: "technology-medium-sha256",
    category: "технологии",
    difficulty: "medium",
    prompt: "Какова длина результата SHA-256?",
    options: ["128 бит", "160 бит", "256 бит", "512 байт"],
    correctIndex: 2,
  },
  {
    id: "technology-medium-container-vm",
    category: "технологии",
    difficulty: "medium",
    prompt: "Какое отличие контейнера от полноценной виртуальной машины обычно верно?",
    options: [
      "Контейнер всегда содержит отдельное ядро",
      "Контейнер обычно использует ядро хост-системы",
      "ВМ не может запускать ОС",
      "Контейнер нельзя ограничить по ресурсам",
    ],
    correctIndex: 1,
  },
  {
    id: "technology-medium-acid-atomicity",
    category: "технологии",
    difficulty: "medium",
    prompt: "Что означает Atomicity в ACID?",
    options: [
      "Транзакция выполняется целиком или не применяется",
      "Данные всегда хранятся в алфавитном порядке",
      "Все запросы выполняются параллельно",
      "Результат нельзя прочитать повторно",
    ],
    correctIndex: 0,
  },
  {
    id: "technology-medium-database-index",
    category: "технологии",
    difficulty: "medium",
    prompt: "Какую цену часто приходится платить за индекс базы данных?",
    options: [
      "Невозможность искать по этому столбцу",
      "Удаление исходной таблицы",
      "Обязательное отключение транзакций",
      "Дополнительное место и стоимость обновления при записи",
    ],
    correctIndex: 3,
  },
  {
    id: "technology-medium-regex-start",
    category: "технологии",
    difficulty: "medium",
    prompt: "Что обычно обозначает символ ^ в начале регулярного выражения?",
    options: ["Конец строки", "Начало строки", "Любой байт", "Повторение предыдущего символа"],
    correctIndex: 1,
  },
  {
    id: "technology-medium-dns-a-record",
    category: "технологии",
    difficulty: "medium",
    prompt: "Что хранит DNS-запись типа A?",
    options: ["Почтовый сервер", "Текстовую заметку", "IPv4-адрес для имени", "IPv6-адрес"],
    correctIndex: 2,
  },
  {
    id: "technology-medium-oauth",
    category: "технологии",
    difficulty: "medium",
    prompt: "Какую задачу решает OAuth?",
    options: [
      "Делегирует доступ без передачи приложению пароля пользователя",
      "Сжимает TCP-пакеты",
      "Заменяет DNS-сервер",
      "Форматирует жёсткий диск",
    ],
    correctIndex: 0,
  },
  {
    id: "technology-medium-asymmetric-crypto",
    category: "технологии",
    difficulty: "medium",
    prompt: "Что характерно для асимметричной криптографии?",
    options: [
      "Всегда применяется один пароль для всех",
      "Шифрование невозможно проверить",
      "Ключи не имеют математической связи",
      "Используется пара открытого и закрытого ключей",
    ],
    correctIndex: 3,
  },
  {
    id: "technology-medium-put-idempotent",
    category: "технологии",
    difficulty: "medium",
    prompt: "Что означает идемпотентность HTTP-метода PUT?",
    options: [
      "Запрос всегда выполняется ровно один раз",
      "Повторение того же запроса должно давать тот же итоговый эффект",
      "Ответ обязательно содержит HTML",
      "Метод нельзя отправлять по TLS",
    ],
    correctIndex: 1,
  },
  {
    id: "technology-medium-garbage-collector",
    category: "технологии",
    difficulty: "medium",
    prompt: "Что обычно освобождает сборщик мусора?",
    options: [
      "Все объекты сразу после создания",
      "Только файлы на диске",
      "Недостижимые из программы объекты",
      "Сетевые порты маршрутизатора",
    ],
    correctIndex: 2,
  },
  {
    id: "technology-medium-cors",
    category: "технологии",
    difficulty: "medium",
    prompt: "Что контролирует CORS в браузере?",
    options: [
      "Правила запросов между разными источниками",
      "Количество ядер процессора",
      "Сжатие изображений на диске",
      "Порядок байтов в файле",
    ],
    correctIndex: 0,
  },
  {
    id: "technology-medium-chmod-executable",
    category: "технологии",
    difficulty: "medium",
    prompt: "Что обычно добавляет команда chmod +x file в Unix?",
    options: [
      "Файл в архив",
      "Сетевой маршрут",
      "Шифрование содержимого",
      "Право на выполнение файла",
    ],
    correctIndex: 3,
  },
  {
    id: "technology-medium-load-balancer",
    category: "технологии",
    difficulty: "medium",
    prompt: "Для чего нужен балансировщик нагрузки?",
    options: [
      "Хранить резервную копию каждого байта",
      "Распределять запросы между несколькими обработчиками",
      "Компилировать клиентский JavaScript",
      "Заменять все TLS-сертификаты",
    ],
    correctIndex: 1,
  },
  {
    id: "technology-medium-eventual-consistency",
    category: "технологии",
    difficulty: "medium",
    prompt: "Что означает eventual consistency в распределённой системе?",
    options: [
      "Все реплики отвечают абсолютно одновременно",
      "Данные никогда не копируются",
      "Реплики сойдутся к одному состоянию, если новые изменения прекращаются",
      "Каждая запись навсегда остаётся только на одном узле",
    ],
    correctIndex: 2,
  },
  {
    id: "technology-hard-cap",
    category: "технологии",
    difficulty: "hard",
    prompt: "Какое упрощённое следствие CAP-теоремы проявляется при сетевом разделении?",
    options: [
      "Приходится выбирать между согласованностью и доступностью",
      "Можно гарантировать всё сразу без компромисса",
      "Система обязана перейти на UDP",
      "Репликация становится невозможной навсегда",
    ],
    correctIndex: 0,
  },
  {
    id: "technology-hard-raft",
    category: "технологии",
    difficulty: "hard",
    prompt: "Какую задачу решает протокол Raft?",
    options: [
      "Сжатие изображений без потерь",
      "Преобразование IPv4 в IPv6",
      "Достижение консенсуса между узлами при отказах",
      "Планирование пикселей на экране",
    ],
    correctIndex: 2,
  },
  {
    id: "technology-hard-aba",
    category: "технологии",
    difficulty: "hard",
    prompt: "В чём проблема ABA в неблокирующих алгоритмах?",
    options: [
      "Два массива всегда имеют одинаковый размер",
      "Значение успело измениться A→B→A, и наблюдатель ошибочно считает его неизменным",
      "Аудиоданные нельзя передать по TCP",
      "Алгоритм содержит ровно два цикла",
    ],
    correctIndex: 1,
  },
  {
    id: "technology-hard-acquire-release",
    category: "технологии",
    difficulty: "hard",
    prompt: "Что дают семантики acquire/release в многопоточном коде?",
    options: [
      "Гарантируют отсутствие всех дедлоков",
      "Заменяют память процессора диском",
      "Делают любой код однопоточным",
      "Ограничивают порядок видимости операций между потоками",
    ],
    correctIndex: 3,
  },
  {
    id: "technology-hard-b-tree",
    category: "технологии",
    difficulty: "hard",
    prompt: "Почему B-деревья часто используют для индексов баз данных?",
    options: [
      "Они уменьшают число обращений к блочным уровням хранения",
      "Они хранят только один ключ",
      "Они не поддерживают сортированный обход",
      "Они требуют загружать всю таблицу в RAM",
    ],
    correctIndex: 0,
  },
  {
    id: "technology-hard-mvcc",
    category: "технологии",
    difficulty: "hard",
    prompt: "Какую идею использует MVCC?",
    options: [
      "Запрещает любые параллельные чтения",
      "Шифрует каждую строку отдельным ключом",
      "Хранит версии данных, чтобы читатели могли видеть согласованный снимок",
      "Удаляет историю сразу после записи",
    ],
    correctIndex: 2,
  },
  {
    id: "technology-hard-wal",
    category: "технологии",
    difficulty: "hard",
    prompt: "Зачем базе данных нужен write-ahead log?",
    options: [
      "Хранить только запросы SELECT",
      "Сначала записать описание изменения, чтобы восстановиться после сбоя",
      "Ускорить рендеринг веб-страниц",
      "Выбирать случайный первичный ключ",
    ],
    correctIndex: 1,
  },
  {
    id: "technology-hard-merkle-tree",
    category: "технологии",
    difficulty: "hard",
    prompt: "Что позволяет обнаружить сравнение корневого хэша Merkle-дерева?",
    options: [
      "Точную температуру процессора",
      "Скорость вращения диска",
      "Имя пользователя в TLS",
      "Изменение набора листьев через сравнение корневого хэша",
    ],
    correctIndex: 3,
  },
  {
    id: "technology-hard-bloom-filter",
    category: "технологии",
    difficulty: "hard",
    prompt: "Какое свойство обычно есть у Bloom-фильтра?",
    options: [
      "Возможны ложные срабатывания, но нет ложных отрицаний",
      "Он хранит точное значение каждого элемента",
      "Он всегда требует сортированный массив",
      "Он шифрует элементы закрытым ключом",
    ],
    correctIndex: 0,
  },
  {
    id: "technology-hard-tls-handshake",
    category: "технологии",
    difficulty: "hard",
    prompt: "Что в основном происходит во время TLS-handshake?",
    options: [
      "Сервер передаёт клиенту весь диск",
      "Клиент компилирует ядро ОС",
      "Стороны проверяют параметры и договариваются о ключах сессии",
      "Маршрутизатор меняет MAC-адрес каждого байта",
    ],
    correctIndex: 2,
  },
  {
    id: "technology-hard-quic",
    category: "технологии",
    difficulty: "hard",
    prompt: "Что характерно для QUIC?",
    options: [
      "Он работает только поверх SMTP",
      "Он реализует над UDP современные механизмы надёжности и управления потоком",
      "Он запрещает шифрование",
      "Он заменяет файловую систему",
    ],
    correctIndex: 1,
  },
  {
    id: "technology-hard-ssa",
    category: "технологии",
    difficulty: "hard",
    prompt: "Какое свойство характерно для SSA в компиляторах?",
    options: [
      "Каждая функция обязана быть рекурсивной",
      "Код хранится только в машинных инструкциях",
      "Все переменные становятся глобальными",
      "Каждое присваивание переменной получает отдельную версию",
    ],
    correctIndex: 3,
  },
  {
    id: "technology-hard-tail-call",
    category: "технологии",
    difficulty: "hard",
    prompt: "Что позволяет оптимизация хвостового вызова?",
    options: [
      "Переиспользовать кадр стека, когда вызов — последнее действие функции",
      "Запустить бесконечную рекурсию без CPU",
      "Заменить все циклы на SQL",
      "Сохранить аргументы только на диске",
    ],
    correctIndex: 0,
  },
  {
    id: "technology-hard-tricolor-gc",
    category: "технологии",
    difficulty: "hard",
    prompt: "Что описывает трёхцветная маркировка в сборке мусора?",
    options: [
      "Три уровня громкости системного динамика",
      "Три копии каждого файла",
      "Состояния белых, серых и чёрных объектов при обходе графа ссылок",
      "Три режима работы сетевой карты",
    ],
    correctIndex: 2,
  },
  {
    id: "technology-hard-mesi",
    category: "технологии",
    difficulty: "hard",
    prompt: "Что описывает протокол когерентности кэша MESI?",
    options: [
      "Четыре уровня TLS-сертификатов",
      "Состояния Modified, Exclusive, Shared и Invalid",
      "Порядок строк в SQL",
      "Алгоритм сжатия аудио",
    ],
    correctIndex: 1,
  },
  {
    id: "technology-hard-epoll",
    category: "технологии",
    difficulty: "hard",
    prompt: "Для чего в Linux обычно применяют epoll?",
    options: [
      "Создавать виртуальные машины",
      "Шифровать разделы диска",
      "Собирать мусор в Java",
      "Получать уведомления о готовности множества файловых дескрипторов",
    ],
    correctIndex: 3,
  },
  {
    id: "technology-hard-lock-convoy",
    category: "технологии",
    difficulty: "hard",
    prompt: "Что такое lock convoy?",
    options: [
      "Потоки выстраиваются за часто занятым lock и теряют параллелизм",
      "Группа ключей шифрует один пакет",
      "Реплики базы синхронизируются без сети",
      "Очередь HTTP-ответов сортируется по размеру",
    ],
    correctIndex: 0,
  },
  {
    id: "technology-hard-crdt",
    category: "технологии",
    difficulty: "hard",
    prompt: "Какую цель преследуют CRDT?",
    options: [
      "Скрывать исходный код от компилятора",
      "Уменьшать размер каждого IP-адреса",
      "Сводить независимые изменения к согласованному результату без единого lock",
      "Запрещать редактирование офлайн",
    ],
    correctIndex: 2,
  },
  {
    id: "technology-hard-timing-side-channel",
    category: "технологии",
    difficulty: "hard",
    prompt: "Что может раскрывать timing side-channel?",
    options: [
      "Только размер экрана",
      "Секретную информацию через различия во времени выполнения",
      "Тип кабеля без измерений",
      "Количество строк в исходном коде",
    ],
    correctIndex: 1,
  },
  {
    id: "technology-hard-zero-knowledge",
    category: "технологии",
    difficulty: "hard",
    prompt: "Что доказывает zero-knowledge proof?",
    options: [
      "Что секрет никогда не существовал",
      "Что любой пароль можно подобрать",
      "Что доказательство не требует проверяющего",
      "Знание секрета без раскрытия самого секрета",
    ],
    correctIndex: 3,
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
  return [...new Set(leylobucksQuizQuestions.map((question) => question.category))];
}

export function createLeylobucksQuiz(
  userId: number,
  attempt: number,
  questionCount: number,
): LeylobucksQuizQuestion[] {
  const categories = questionCategories();
  const byCategory = new Map<string, LeylobucksQuizQuestion[]>();
  for (const question of leylobucksQuizQuestions) {
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
