// Second test fixture, kept deliberately hostile to the parser.
//
// Every construct here has broken a naive version of the scanner at some point:
// triple-quoted and raw strings hiding fake widgets, a stray closing brace
// inside a string, comments containing widget calls, collection-if, switch
// expressions, `.map()`, nested lambdas, named constructors, a widget getter,
// and non-widget classes that look exactly like widgets (EdgeInsets, Theme.of,
// BoxDecoration).

import 'package:flutter/material.dart';

class Traps extends StatelessWidget {
  const Traps({super.key, required this.items});

  final List<String> items;

  static const Widget empty = SizedBox.shrink();

  Widget get header => Text(r'raw string with Text(trap)');

  @override
  Widget build(BuildContext context) {
    final hint = Text('''
      Multiline text with Container(trap)
      and a lone closing brace }
    ''');
    return ListView(
      padding: EdgeInsets.symmetric(horizontal: 8),
      children: [
        hint,
        header,
        if (items.isEmpty) const Center(child: Text('empty')) else Column(
          children: items.map((e) => ListTile(
            leading: const Icon(Icons.label),
            title: Text('item $e'),
          )).toList(),
        ),
        switch (items.length) {
          0 => const Text('zero'),
          1 => const Text('one'),
          _ => Badge(label: Text('${items.length}')),
        },
        Builder(builder: (context) {
          final color = Theme.of(context).primaryColor;
          return Container(
            decoration: BoxDecoration(color: color),
            child: Image.network('https://example.test/a.png'),
          );
        }),
        ListView.builder(
          itemCount: items.length,
          itemBuilder: (context, index) => Text(items[index]),
        ),
      ],
    );
  }
}
