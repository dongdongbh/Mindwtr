type RowFromValues = (values: unknown[]) => Record<string, unknown>;

const builders = new Map<string, RowFromValues>();

const rowBuilder = (columns: string[]): RowFromValues => {
    const shape = JSON.stringify(columns);
    let build = builders.get(shape);
    if (!build) {
        const fields = columns.map((column, index) => `${column === '__proto__' ? '["__proto__"]' : JSON.stringify(column)}:values[${index}]`);
        build = new Function('values', `return {${fields.join(',')}};`) as RowFromValues;
        if (builders.size >= 256) builders.clear();
        builders.set(shape, build);
    }
    return build;
};

export const rowsFromArrayReply = <T,>(text: string): T[] => {
    const reply = JSON.parse(text) as [string[], ...unknown[][]];
    const build = rowBuilder(reply[0]);
    const rows: T[] = [];
    for (let index = 1; index < reply.length; index += 1) rows.push(build(reply[index]) as T);
    return rows;
};
