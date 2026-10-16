export const STATUS = Object.freeze({
  OPEN: "open",
  DONE: "done",
  ARCHIVED: "archived",
});

export const parseArguments = (argv) => {
  const [name = "list", ...rest] = argv;
  if (name === "add") return { name, text: rest.join(" ") };
  if (name === "serve") return { name };
  return { name: "list" };
};

export const addNote = (notes, text) => [
  ...notes,
  {
    id: notes.length + 1,
    text,
    status: STATUS.OPEN,
    created_at: new Date().toISOString(),
  },
];

export const listNotes = (notes) =>
  notes.map((note) => `${note.id}. [${note.status}] ${note.text}`);
